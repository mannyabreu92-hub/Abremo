// Database tests: run the Supabase migration on a real Postgres and check the security rules.
// Skipped unless ABREMI_PG holds psql connection flags, e.g.
//   ABREMI_PG="-h /tmp/abremi-pg -p 54329 -U postgres" npm run test:db
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { battleResult, expectedScore } from '../src/core/elo.js';
import { buildSeedWorld } from '../src/core/seed.js';
import { seedSQL, setupSQL } from '../scripts/gen-seed-sql.js';
import { memberBoards } from '../src/core/leaderboards.js';
import { battleStreak, seasonWindow } from '../src/core/streak.js';
import { sampleCatalog, snapshotToCommunity } from '../src/core/community.js';
import { artworkInfluence } from '../src/core/scoring.js';
import { PLANS } from '../src/core/plans.js';

const flags = process.env.ABREMI_PG?.split(/\s+/).filter(Boolean);
const skip = !flags && 'set ABREMI_PG to run database tests';
let DB = `abremi_test_${process.pid}`;
const file = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function psql(sql, db = DB) {
  return execFileSync('psql', [...flags, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qtA', '-f', '-'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Run SQL as an API user: anon, or authenticated with a user id, or service_role. */
function as(who, sql) {
  const role = who === 'anon' || who === 'service_role' ? who : 'authenticated';
  const sub = role === 'authenticated' ? who : '';
  return psql(`begin;
do $$ begin
  perform set_config('request.jwt.claim.sub', '${sub}', true);
  perform set_config('request.jwt.claim.role', '${role}', true);
end $$;
set local role ${role};
${sql};
commit;`);
}

function fails(who, sql, pattern) {
  assert.throws(() => as(who, sql), (e) => pattern.test(String(e.stderr || e.message)), `expected failure matching ${pattern}`);
}

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const E = '00000000-0000-0000-0000-00000000000e';
const seed = sampleCatalog(buildSeedWorld()); // the shared catalog: every work starts at the same rating
const [w1, w2] = (() => {
  const a = seed.artworks[0];
  return [a, seed.artworks.find((w) => w.artistId !== a.artistId)];
})();

// Supabase's "Automatically expose new tables" project option: on = API roles get default
// table privileges; off = only what the migration grants explicitly. Test both.
const STUBS = {
  'tables exposed by default': file('supabase/test/auth_stub.sql'),
  'tables not exposed by default': file('supabase/test/auth_stub.sql')
    .replace(/alter default privileges in schema public grant all on tables to anon, authenticated, service_role;/, 'alter default privileges in schema public grant all on tables to service_role;')
    .replace(/alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;/, 'alter default privileges in schema public grant all on sequences to service_role;')
    .replace(/alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;/, 'alter default privileges in schema public revoke execute on functions from public;\nalter default privileges in schema public grant execute on functions to service_role;'),
};

/** Reading private rows as a guest must return nothing, or be refused outright. */
function noRowsFor(who, sql) {
  try { assert.equal(as(who, sql), '0'); } catch (e) { assert.match(String(e.stderr || e.message), /permission denied|^0$/); }
}

for (const [mode, stub] of Object.entries(STUBS)) test(`database (${mode})`, { skip }, async (t) => {
  assert.notEqual(STUBS['tables exposed by default'], STUBS['tables not exposed by default'], 'strict stub must differ');
  DB = `abremi_test_${process.pid}_${mode.startsWith('tables exposed') ? 'open' : 'strict'}`;
  psql(`drop database if exists ${DB}`, 'postgres');
  psql(`create database ${DB}`, 'postgres');
  t.after(() => psql(`drop database if exists ${DB}`, 'postgres'));
  psql(stub);
  psql(file('supabase/setup.sql')); // the exact file people paste into Supabase
  psql(file('supabase/setup.sql')); // and running it twice is safe
  psql(`insert into auth.users (id, email) values ('${A}', 'ana@example.com'), ('${B}', 'ben@example.com'), ('${C}', 'cy@example.com'), ('${E}', 'eve@example.com')`);

  await t.test('seed.sql and setup.sql are in sync with the app catalog and migration', () => {
    assert.equal(file('supabase/seed.sql'), seedSQL());
    assert.equal(file('supabase/setup.sql'), setupSQL());
    assert.equal(psql('select count(*) from artworks'), String(seed.artworks.length));
  });

  await t.test('signing up creates a fan profile with a neutral name (never part of the email)', () => {
    const [name, role] = as(A, 'select name || \'|\' || role from profiles').split('|');
    assert.match(name, /^Member [0-9A-F]{4}$/);
    assert.ok(!name.toLowerCase().includes('ana'));
    assert.equal(role, 'fan');
  });

  await t.test('people only see their own profile', () => {
    assert.equal(as(A, 'select count(*) from profiles'), '1');
    noRowsFor('anon', 'select count(*) from profiles');
  });

  await t.test('fan and artist roles are self-service; critic and collector need an admin', () => {
    as(A, `update profiles set role = 'artist', name = 'Ana', country = 'FR' where id = '${A}'`);
    assert.equal(as(A, 'select role || \'|\' || country from profiles'), 'artist|FR');
    fails(A, `update profiles set role = 'collector' where id = '${A}'`, /require verification/);
    fails(A, `update profiles set role = 'critic' where id = '${A}'`, /require verification/);
    as('service_role', `update profiles set role = 'critic' where id = '${C}'`);
    assert.equal(as(C, 'select role from profiles'), 'critic');
  });

  await t.test('nobody can edit someone else\'s profile', () => {
    as(A, `update profiles set name = 'Hacked' where id = '${B}'`);
    assert.match(as(B, 'select name from profiles'), /^Member [0-9A-F]{4}$/);
  });

  await t.test('reactions are stamped with the server-side role, never the client\'s', () => {
    as(A, `insert into reactions (artwork_id, kind, role) values ('${w1.id}', 'like', 'collector')`);
    assert.equal(as(A, `select role from reactions where artwork_id = '${w1.id}'`), 'artist');
  });

  await t.test('reactions are private and cannot be written for someone else', () => {
    assert.equal(as(B, 'select count(*) from reactions'), '0');
    noRowsFor('anon', 'select count(*) from reactions');
    fails(B, `insert into reactions (user_id, artwork_id, kind) values ('${A}', '${w2.id}', 'like')`, /row-level security/);
    fails('anon', `insert into reactions (artwork_id, kind) values ('${w2.id}', 'like')`, /permission denied|row-level security|Profile missing/);
    fails(A, `insert into reactions (artwork_id, kind) values ('nope', 'like')`, /foreign key/);
    fails(A, `insert into reactions (artwork_id, kind) values ('${w2.id}', 'love')`, /check constraint/);
  });

  await t.test('a reaction can change kind and be removed', () => {
    as(A, `insert into reactions (artwork_id, kind) values ('${w1.id}', 'super') on conflict (user_id, artwork_id) do update set kind = excluded.kind`);
    assert.equal(as(A, `select kind from reactions where artwork_id = '${w1.id}'`), 'super');
    as(B, `delete from reactions where artwork_id = '${w1.id}'`);
    assert.equal(psql(`select count(*) from reactions where artwork_id = '${w1.id}'`), '1');
  });

  await t.test('follows: own rows only, stamped role', () => {
    as(B, `insert into follows (artist_id, role) values ('${w1.artistId}', 'collector')`);
    assert.equal(as(B, 'select role from follows'), 'fan');
    assert.equal(as(A, 'select count(*) from follows'), '0');
  });

  await t.test('only critics can review; reviews are public', () => {
    fails(A, `insert into reviews (artwork_id, rating) values ('${w1.id}', 5)`, /row-level security/);
    as(C, `insert into reviews (artwork_id, rating, body) values ('${w1.id}', 4, 'Strong')`);
    assert.equal(as('anon', 'select count(*) from reviews'), '1');
    fails(C, `insert into reviews (artwork_id, rating) values ('${w2.id}', 6)`, /check constraint/);
  });

  await t.test('battle votes match the app\'s Elo maths exactly', () => {
    const row = as(B, `select winner_rating || '|' || loser_rating || '|' || gain || '|' || loss || '|' || crowd from cast_battle_vote('${w2.id}', '${w1.id}')`);
    const r = battleResult(w2.elo, w1.elo, 'fan');
    const crowd = Math.round(expectedScore(w2.elo, w1.elo) * 100);
    assert.equal(row, `${r.winner}|${r.loser}|${r.gain}|${r.loss}|${crowd}`);
    assert.equal(as('anon', `select rating from artwork_ratings where artwork_id = '${w2.id}'`), String(r.winner));
  });

  await t.test('a collector-weight vote uses K = 52, stamped from the server', () => {
    as('service_role', `update profiles set role = 'collector' where id = '${A}'`);
    const before = Number(psql(`select coalesce((select rating from artwork_ratings where artwork_id = '${seed.artworks[10].id}'), ${seed.artworks[10].elo})`));
    const other = seed.artworks.find((w) => w.artistId !== seed.artworks[10].artistId && w.id !== w1.id && w.id !== w2.id);
    const row = as(A, `select gain from cast_battle_vote('${seed.artworks[10].id}', '${other.id}')`);
    assert.equal(Number(row), battleResult(before, other.elo, 'collector').gain);
  });

  await t.test('battle votes are guarded', () => {
    fails('anon', `select * from cast_battle_vote('${w1.id}', '${w2.id}')`, /permission denied|Sign in/);
    fails(B, `select * from cast_battle_vote('${w1.id}', '${w2.id}')`, /one vote per second|already judged/);
    psql(`update battle_votes set created_at = now() - interval '5 seconds'`);
    fails(B, `select * from cast_battle_vote('${w1.id}', '${w2.id}')`, /already judged this pair/);
    const same = seed.artworks.find((w) => w.artistId === w1.artistId && w.id !== w1.id);
    fails(B, `select * from cast_battle_vote('${w1.id}', '${same.id}')`, /different artists/);
    fails(B, `select * from cast_battle_vote('${w1.id}', 'nope')`, /Unknown artworks/);
    fails(B, `insert into artwork_ratings (artwork_id, rating) values ('${w1.id}', 9999)`, /permission denied|row-level security/);
    fails(B, `insert into battle_votes (user_id, winner_id, loser_id, role, gain, loss) values ('${B}', '${w1.id}', '${w2.id}', 'fan', 99, 0)`, /permission denied|row-level security/);
  });

  await t.test('community snapshot exposes totals only, to everyone', () => {
    const snap = JSON.parse(as('anon', 'select community_snapshot()::text'));
    assert.deepEqual(snap.reactions, [{ a: w1.id, k: 'super', r: 'artist', n: 1 }]);
    assert.deepEqual(snap.reviews, [{ a: w1.id, n: 1, s: 4 }]);
    assert.deepEqual(snap.follows, [{ a: w1.artistId, r: 'fan', n: 1 }]);
    assert.equal(snap.ratings.length, 4);
    assert.equal(snap.members, 4);
    assert.ok(!JSON.stringify(snap).includes(A));
  });

  // ——— Artist uploads ———
  const put = (who, name) => as(who, `insert into storage.objects (bucket_id, name) values ('artworks', '${name}')`);
  const publish = (who, { image = `${E}/a.webp`, thumb = `${E}/a-thumb.webp`, category = 'oil', title = 'First Light' } = {}) =>
    as(who, `select id || '|' || artist_id from publish_artwork('${title}', '${category}', 'Abstract', 'Oil on canvas', 2026, 450, '${image}', '${thumb}', 1200, 1600)`);
  let uploadId;

  await t.test('fans cannot upload images or publish', () => {
    fails(E, `insert into storage.objects (bucket_id, name) values ('artworks', '${E}/x.webp')`, /row-level security/);
    fails(E, `select * from publish_artwork('X', 'oil', 'Abstract', '', 2026, 100, '${E}/x.webp', '${E}/y.webp', 10, 10)`, /Switch to the Artist role/);
    fails('anon', `select * from publish_artwork('X', 'oil', 'Abstract', '', 2026, 100, 'a', 'b', 10, 10)`, /permission denied|Sign in/);
  });

  await t.test('artists upload only into their own folder', () => {
    as(E, `update profiles set role = 'artist' where id = '${E}'`);
    put(E, `${E}/a.webp`);
    put(E, `${E}/a-thumb.webp`);
    fails(E, `insert into storage.objects (bucket_id, name) values ('artworks', '${A}/sneaky.webp')`, /row-level security/);
    fails(E, `insert into storage.objects (bucket_id, name) values ('other', '${E}/x.webp')`, /row-level security|foreign key/);
  });

  await t.test('publishing needs the uploaded files and valid details', () => {
    fails(E, `select * from publish_artwork('X', 'oil', 'Abstract', '', 2026, 100, '${E}/a.webp', '${E}/missing.webp', 10, 10)`, /Upload the image before publishing/);
    fails(E, `select * from publish_artwork('X', 'oil', 'Abstract', '', 2026, 100, '${A}/a.webp', '${A}/b.webp', 10, 10)`, /Upload the image before publishing/);
    assert.throws(() => publish(E, { category: 'crayons' }), (e) => /check constraint/.test(String(e.stderr)));
    const [id, artist] = publish(E).split('|');
    assert.match(id, /^u_[0-9a-f]{32}$/);
    assert.equal(artist, `m_${E}`);
    uploadId = id;
    const eveName = psql(`select name from profiles where id = '${E}'`);
    assert.equal(psql(`select name || '|' || country || '|' || owner_id from artists where id = 'm_${E}'`), `${eveName}|US|${E}`);
    fails(E, `insert into artworks (id, artist_id, title, base_elo) values ('u_fake', 'm_${E}', 'Fake', 3000)`, /row-level security|permission denied/);
  });

  await t.test('published works are public and take part in likes, snapshot and battles', () => {
    assert.equal(as('anon', `select title from artworks where id = '${uploadId}'`), 'First Light');
    as(B, `insert into reactions (artwork_id, kind) values ('${uploadId}', 'like')`);
    const snap = JSON.parse(as('anon', 'select community_snapshot()::text'));
    const up = snap.uploads.find((u) => u.id === uploadId);
    assert.deepEqual([up.artist_id, up.category, up.style, up.price, up.width, up.height, up.image_path], [`m_${E}`, 'oil', 'Abstract', 450, 1200, 1600, `${E}/a.webp`]);
    assert.ok(snap.artists.some((a) => a.id === `m_${E}` && /^Member [0-9A-F]{4}$/.test(a.name)));
    assert.ok(snap.reactions.some((r) => r.a === uploadId && r.k === 'like' && r.n === 1));
    psql(`update battle_votes set created_at = now() - interval '1 hour'`);
    const loserBefore = Number(psql(`select coalesce((select rating from artwork_ratings where artwork_id = '${w2.id}'), ${w2.elo})`));
    const expected = battleResult(1200, loserBefore, 'fan');
    assert.equal(as(B, `select winner_rating || '|' || loser_rating from cast_battle_vote('${uploadId}', '${w2.id}')`), `${expected.winner}|${expected.loser}`);
  });

  await t.test('a member’s artist name follows their profile', () => {
    as(E, `update profiles set name = 'Eve Studio', country = 'FR' where id = '${E}'`);
    assert.equal(psql(`select name || '|' || country from artists where id = 'm_${E}'`), 'Eve Studio|FR');
  });

  await t.test('only the owner can delete a work; its likes go with it', () => {
    fails(B, `select * from delete_artwork('${uploadId}')`, /Not your artwork/);
    as(B, `delete from storage.objects where name like '${E}/%'`); // silently matches nothing: not B's files
    assert.equal(psql(`select count(*) from storage.objects where name like '${E}/a%'`), '2');
    assert.equal(as(E, `select image_path || '|' || thumb_path from delete_artwork('${uploadId}')`), `${E}/a.webp|${E}/a-thumb.webp`);
    assert.equal(psql(`select count(*) from reactions where artwork_id = '${uploadId}'`), '0');
    assert.equal(psql(`select count(*) from artwork_ratings where artwork_id = '${uploadId}'`), '0');
    as(E, `delete from storage.objects where name in ('${E}/a.webp', '${E}/a-thumb.webp')`);
    assert.equal(psql(`select count(*) from storage.objects where name like '${E}/a%'`), '0');
  });

  await t.test('hidden (moderated) works disappear for everyone', () => {
    put(E, `${E}/h.webp`);
    put(E, `${E}/h-thumb.webp`);
    const [id] = publish(E, { image: `${E}/h.webp`, thumb: `${E}/h-thumb.webp`, title: 'Hidden' }).split('|');
    as('service_role', `update artworks set hidden = true where id = '${id}'`);
    assert.equal(as('anon', `select count(*) from artworks where id = '${id}'`), '0');
    assert.ok(!JSON.parse(as('anon', 'select community_snapshot()::text')).uploads.some((u) => u.id === id));
  });

  await t.test('an artist can publish at most 20 works a day', () => {
    as(E, `do $$ begin
      for i in 1..19 loop
        insert into storage.objects (bucket_id, name) values ('artworks', '${E}/n' || i || '.webp'), ('artworks', '${E}/n' || i || '-t.webp');
        perform publish_artwork('Work ' || i, 'digital', 'Futurism', '', 2026, 100, '${E}/n' || i || '.webp', '${E}/n' || i || '-t.webp', 800, 600);
      end loop;
    end $$`);
    put(E, `${E}/z.webp`);
    put(E, `${E}/z-thumb.webp`);
    assert.throws(() => publish(E, { image: `${E}/z.webp`, thumb: `${E}/z-thumb.webp` }), (e) => /Daily limit reached/.test(String(e.stderr)));
  });

  // ——— Member leaderboards ———
  const L = Array.from({ length: 6 }, (_, i) => `00000000-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`);
  const reference = (me) => {
    const profiles = JSON.parse(psql(`select json_agg(json_build_object('id', id, 'name', name, 'country', country, 'role', role, 'public', public_leaderboards)) from profiles`));
    const reactions = JSON.parse(psql(`select coalesce(json_agg(json_build_object('user', user_id, 'artwork', artwork_id, 'kind', kind, 'role', role, 'at', (extract(epoch from created_at) * 1000000)::bigint)), '[]') from reactions`));
    const reviews = JSON.parse(psql(`select coalesce(json_agg(json_build_object('user', user_id, 'rating', rating)), '[]') from reviews`));
    return memberBoards({ profiles, reactions, reviews }, { me });
  };
  const boards = (who, args = '') => JSON.parse(as(who, `select member_leaderboards(${args})::text`));

  await t.test('leaderboards: collectors, critics and discoverers, identical to the JavaScript reference', () => {
    psql(`insert into auth.users (id, email) values ${L.map((id, i) => `('${id}', 'lb${i}@example.com')`).join(', ')}`);
    as('service_role', `update profiles set role = 'collector', country = 'DO' where id = '${L[0]}'`);
    as('service_role', `update profiles set role = 'critic', country = 'FR' where id = '${L[1]}'`);
    const works = seed.artworks.slice(100, 106).map((w) => w.id);
    // L[2] finds three works first; the others arrive later, so L[2] is the early discoverer.
    const like = (who, w, kind = 'like') => as(who, `insert into reactions (artwork_id, kind) values ('${w}', '${kind}') on conflict do nothing`);
    for (const w of works.slice(0, 3)) like(L[2], w);
    for (const who of [L[0], L[1], L[3], L[4], L[5]]) for (const w of works.slice(0, 4)) like(who, w, who === L[0] ? 'super' : 'like');
    like(L[3], works[5]);
    as(L[1], `insert into reviews (artwork_id, rating, body) values ('${works[0]}', 5, 'Remarkable'), ('${works[1]}', 3, '')`);
    // Make the order explicit: L[2] first, then everyone else a minute apart.
    psql(`update reactions set created_at = now() - interval '1 day' where user_id = '${L[2]}'`);
    L.forEach((id, i) => { if (i !== 2) psql(`update reactions set created_at = now() - interval '${60 - i} minutes' where user_id = '${id}'`); });

    const anon = boards('anon');
    assert.deepEqual(anon, reference(null));
    assert.deepEqual(boards(L[2]), reference(L[2]));
    assert.equal(anon.collectors[0].score, 4 * 2 * 9);
    assert.equal(anon.critics[0].score, 4 * 5 + 2 * 5 + 2 * 3);
    assert.equal(anon.critics[0].detail, 2);
    assert.equal(anon.discoverers[0].me, false);
    const top = anon.discoverers[0];
    assert.equal(top.name, psql(`select name from profiles where id = '${L[2]}'`), 'the earliest discoverer leads');
    assert.ok(top.score > 0 && top.score <= 100);
    assert.equal(boards(L[2]).me.discoverers.rank, 1);
  });

  await t.test('leaderboards never expose ids or emails, and respect opting out', () => {
    const text = as('anon', 'select member_leaderboards()::text');
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), 'no user ids');
    assert.ok(!text.includes('example.com'), 'no emails');
    as(L[2], `update profiles set public_leaderboards = false where id = '${L[2]}'`);
    const hidden = boards('anon');
    assert.ok(!hidden.discoverers.some((r) => r.name === psql(`select name from profiles where id = '${L[2]}'`)));
    assert.deepEqual(hidden, reference(null));
    const self = boards(L[2]);
    assert.equal(self.me.discoverers.rank, 1, 'you still see your own standing');
    assert.ok(self.discoverers.some((r) => r.me), 'and yourself on the board, privately');
    assert.deepEqual(self, reference(L[2]));
    as(L[3], `update profiles set public_leaderboards = true where id = '${L[2]}'`); // someone else can't opt you back in
    assert.equal(psql(`select public_leaderboards from profiles where id = '${L[2]}'`), 'f');
  });

  await t.test('leaderboards filter by country and cap the list size', () => {
    const dominican = boards('anon', `'DO'`);
    assert.equal(dominican.collectors.length, 1);
    assert.equal(dominican.critics.length, 0);
    assert.ok(dominican.discoverers.every((r) => r.country === 'DO'));
    assert.equal(boards('anon', `null, 1`).discoverers.length, 1);
    assert.ok(boards('anon', `null, 100000`).discoverers.length <= 100);
  });

  // ——— Critic & Collector applications ———
  const P = ['00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000203'];
  const STATEMENT = 'I have reviewed contemporary painting for eight years, mostly for regional newspapers and two art quarterlies.';
  const apply = (who, role = 'critic', links = `array['https://example.org/portfolio']`) =>
    as(who, `select id || '|' || status from apply_for_role('${role}', '${STATEMENT}', ${links})`);

  await t.test('applications: members apply with a statement and https links; limits apply', () => {
    psql(`insert into auth.users (id, email) values ('${P[0]}', 'applicant@example.com'), ('${P[1]}', 'admin@example.com'), ('${P[2]}', 'other@example.com')`);
    fails('anon', `select * from apply_for_role('critic', '${STATEMENT}')`, /permission denied|Sign in/);
    fails(P[0], `select * from apply_for_role('artist', '${STATEMENT}')`, /Critic or a Collector/);
    fails(P[0], `select * from apply_for_role('critic', 'too short')`, /check constraint/);
    fails(P[0], `select * from apply_for_role('critic', '${STATEMENT}', array['http://insecure.example'])`, /https/);
    fails(P[0], `select * from apply_for_role('critic', '${STATEMENT}', array['javascript:alert(1)'])`, /https/);
    fails(P[0], `select * from apply_for_role('critic', '${STATEMENT}', array['https://a.io/1','https://a.io/2','https://a.io/3','https://a.io/4','https://a.io/5','https://a.io/6'])`, /check constraint/);
    const [, status] = apply(P[0]).split('|');
    assert.equal(status, 'pending');
    fails(P[0], `select * from apply_for_role('critic', '${STATEMENT}')`, /already have a pending application/);
    assert.equal(as(P[0], 'select count(*) from role_applications'), '1');
    assert.equal(as(P[2], 'select count(*) from role_applications'), '0', 'applications are private');
    fails(P[0], `insert into role_applications (user_id, role, statement) values ('${P[0]}', 'collector', '${STATEMENT}')`, /permission denied|row-level security/);
    fails(P[0], `update role_applications set status = 'approved'`, /permission denied/);
    assert.equal(as(P[0], 'select role from profiles'), 'fan', 'applying does not grant anything');
  });

  await t.test('applications: only admins can see the queue or decide', () => {
    fails(P[2], 'select * from admin_role_queue()', /Admins only/);
    fails(P[2], `select * from decide_role_application((select id from role_applications limit 1), true)`, /Admins only|permission denied/);
    fails(P[1], `insert into admins (user_id) values ('${P[1]}')`, /permission denied/);
    assert.equal(as(P[1], 'select is_admin()'), 'f');
    psql(`insert into admins (user_id) values ('${P[1]}')`); // done once, by you, in the SQL editor
    assert.equal(as(P[1], 'select is_admin()'), 't');
    const row = as(P[1], `select role || '|' || applicant_role || '|' || email || '|' || cardinality(links) from admin_role_queue()`);
    assert.equal(row, 'critic|fan|applicant@example.com|1');
  });

  await t.test('approving grants the role, and new votes carry its weight', () => {
    const id = as(P[0], 'select id from role_applications');
    const decided = as(P[1], `select status || '|' || coalesce(decision_note, '') from decide_role_application('${id}', true, 'Welcome')`);
    assert.equal(decided, 'approved|Welcome');
    assert.equal(as(P[0], 'select role from profiles'), 'critic');
    as(P[0], `insert into reactions (artwork_id, kind) values ('${seed.artworks[200].id}', 'like')`);
    assert.equal(as(P[0], `select role from reactions where artwork_id = '${seed.artworks[200].id}'`), 'critic');
    as(P[0], `insert into reviews (artwork_id, rating) values ('${seed.artworks[200].id}', 4)`); // critics can now review
    fails(P[1], `select * from decide_role_application('${id}', false)`, /no longer pending/);
    fails(P[0], `select * from apply_for_role('critic', '${STATEMENT}')`, /already have this role/);
    assert.ok(as(P[1], 'select name || role from admin_verified_members()').includes('critic'));
  });

  await t.test('declines carry a note; members can withdraw; three applications per 30 days', () => {
    apply(P[2], 'collector');
    const id = as(P[2], 'select id from role_applications');
    assert.equal(as(P[1], `select status || '|' || decision_note from decide_role_application('${id}', false, 'Please add links to sales records')`), 'declined|Please add links to sales records');
    assert.equal(as(P[2], 'select role from profiles'), 'fan');
    assert.equal(as(P[2], 'select decision_note from role_applications'), 'Please add links to sales records');
    apply(P[2], 'collector');
    as(P[2], `select withdraw_role_application((select id from role_applications where status = 'pending'))`);
    fails(P[2], `select withdraw_role_application((select id from role_applications limit 1))`, /No pending application/);
    apply(P[2], 'critic'); // the third application in 30 days is still allowed…
    as(P[2], `select withdraw_role_application((select id from role_applications where status = 'pending'))`);
    fails(P[2], `select * from apply_for_role('critic', '${STATEMENT}')`, /three applications every 30 days/); // …the fourth is not
  });

  await t.test('admins can revoke a verified role; nobody else can', () => {
    fails(P[2], `select revoke_role('${P[0]}')`, /Admins only|permission denied/);
    as(P[1], `select revoke_role('${P[0]}', 'Vote manipulation')`);
    assert.equal(as(P[0], 'select role from profiles'), 'fan');
    assert.equal(as(P[0], `select role from reactions where artwork_id = '${seed.artworks[200].id}'`), 'critic', 'past votes keep the weight they had');
    fails(P[1], `select revoke_role('${P[0]}')`, /no verified role/);
    fails(P[0], `update profiles set role = 'critic' where id = '${P[0]}'`, /require verification/);
  });

  await t.test('live pulse: public, read-only, bumped by community activity and broadcast by Realtime', () => {
    const version = () => Number(as('anon', 'select version from community_pulse'));
    const rewind = () => psql(`update community_pulse set changed_at = now() - interval '1 minute'`);
    assert.equal(as('anon', 'select count(*) from community_pulse'), '1');
    rewind();
    const v0 = version();
    as(A, `insert into reactions (artwork_id, kind) values ('${seed.artworks[300].id}', 'like')`);
    const v1 = version();
    assert.equal(v1, v0 + 1, 'a like bumps the pulse');
    as(A, `delete from reactions where artwork_id = '${seed.artworks[300].id}'`);
    assert.equal(version(), v1, 'throttled to one bump per second');
    rewind();
    as(B, `insert into follows (artist_id) values ('${seed.artists[40].id}')`);
    assert.equal(version(), v1 + 1, 'a follow bumps the pulse');
    rewind();
    const rival = seed.artworks.find((w) => w.artistId !== seed.artworks[301].artistId);
    as(C, `select * from cast_battle_vote('${seed.artworks[301].id}', '${rival.id}')`);
    assert.equal(version(), v1 + 2, 'a battle vote bumps the pulse');
    for (const who of ['anon', A]) {
      noRowsFor(who, `with u as (update community_pulse set version = 0 returning 1) select count(*) from u`);
      fails(who, `select bump_community_pulse()`, /permission denied|trigger functions can only be called/);
    }
    assert.equal(psql(`select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'community_pulse'`), '1');
    assert.equal(psql(`select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename <> 'community_pulse'`), '0', 'no other table is broadcast');
  });

  await t.test('hourly charts: kept once an hour, totals only, baseline from an earlier hour within 24 hours', () => {
    psql('delete from community_history');
    assert.equal(as('anon', 'select chart_baseline() is null'), 't', 'no earlier chart → no movement');
    assert.equal(psql('select count(*) from community_history'), '1', 'this hour is kept');
    as('anon', 'select chart_baseline()');
    assert.equal(psql('select count(*) from community_history'), '1', 'once per hour');
    const keys = psql(`select string_agg(k, ',' order by k) from community_history, jsonb_object_keys(snapshot) k`);
    assert.equal(keys, 'artist_scores,follows,members,ratings,reactions,reviews,scores', 'totals and scores only: no uploads list, no member details');
    // An earlier chart, and one too old to compare against.
    psql(`insert into community_history (hour, taken_at, snapshot) values
      (date_trunc('hour', now()) - interval '2 hours', date_trunc('hour', now()) - interval '2 hours', '{"members": 1}'),
      (date_trunc('hour', now()) - interval '30 hours', date_trunc('hour', now()) - interval '30 hours', '{"members": 0}')`);
    const base = JSON.parse(as(A, 'select chart_baseline()'));
    assert.equal(base.snapshot.members, 1);
    assert.equal(Date.parse(base.hour), Date.parse(psql(`select to_json(date_trunc('hour', now()) - interval '2 hours')`).replace(/"/g, '')));
    psql(`delete from community_history where hour = date_trunc('hour', now()) - interval '2 hours'`);
    assert.equal(as('anon', 'select chart_baseline() is null'), 't', 'a 30-hour-old chart is too old');
    for (const who of ['anon', A]) {
      noRowsFor(who, `with u as (insert into community_history (hour, snapshot) values (now() + interval '1 day', '{}') returning 1) select count(*) from u`);
      fails(who, `select take_community_history()`, /permission denied/);
    }
  });

  await t.test('ensure_profile heals a missing profile', () => {
    const D = '00000000-0000-0000-0000-00000000000d';
    psql(`alter table auth.users disable trigger on_auth_user_created; insert into auth.users (id, email) values ('${D}', 'dee@example.com'); alter table auth.users enable trigger on_auth_user_created;`);
    assert.equal(as(D, 'select count(*) from profiles'), '0');
    assert.equal(as(D, 'select role from ensure_profile()'), 'fan');
    fails('anon', 'select * from ensure_profile()', /permission denied|Sign in/);
  });

  // ——— Phase 1 (0006): audit trail, artist profiles, artwork details, collections ———
  await t.test('audit trail: sensitive actions are recorded; only admins can read it', () => {
    const log = as(P[1], `select string_agg(action, ',' order by created_at) from admin_audit_log()`);
    assert.match(log, /role_application\.approved/);
    assert.match(log, /role_application\.declined/);
    assert.match(log, /role\.revoked/);
    assert.equal(as(P[1], `select actor_email from admin_audit_log() where action = 'role.revoked' limit 1`), 'admin@example.com');
    fails(P[0], 'select * from admin_audit_log()', /Admins only|permission denied/);
    for (const who of ['anon', P[0]]) noRowsFor(who, 'select count(*) from audit_events');
    fails(P[0], `select log_audit('x', 'y', 'z')`, /permission denied/);
    noRowsFor(P[0], `with u as (insert into audit_events (action, target_type, target_id) values ('fake', 'x', 'y') returning 1) select count(*) from u`);
  });

  await t.test('artist profiles: owners edit their own, with validated links and portraits', () => {
    put(E, `${E}/portrait.webp`);
    as(E, `select * from update_artist_profile('Painter of light.', 'I paint coastlines.', 'https://example.org', '@eve.paints', 'Lisbon', '${E}/portrait.webp')`);
    assert.equal(psql(`select bio || '|' || instagram || '|' || city from artists where owner_id = '${E}'`), 'Painter of light.|eve.paints|Lisbon');
    fails(E, `select * from update_artist_profile('', '', 'http://insecure.example', '', '', null)`, /artists_profile_valid/);
    fails(E, `select * from update_artist_profile('', '', '', 'bad handle!', '', null)`, /artists_profile_valid/);
    fails(E, `select * from update_artist_profile('', '', '', '', '', '${A}/portrait.webp')`, /Upload the portrait/);
    fails(E, `select * from update_artist_profile('${'x'.repeat(1001)}', '', '', '', '', null)`, /artists_profile_valid/);
    fails(B, `select * from update_artist_profile('Not mine', '', '', '', '', null)`, /Switch to the Artist role/);
    fails('anon', `select * from update_artist_profile('x', '', '', '', '', null)`, /permission denied|Sign in/);
    noRowsFor(B, `with u as (update artists set bio = 'hacked' where owner_id = '${E}' returning 1) select count(*) from u`);
    assert.equal(psql(`select bio from artists where owner_id = '${E}'`), 'Painter of light.');
    const snap = JSON.parse(as('anon', 'select community_snapshot()'));
    assert.equal(snap.artists.find((a) => a.id === `m_${E}`).city, 'Lisbon');
  });

  let work;
  await t.test('artwork details: only the owner edits; availability is validated; deletions are recorded', () => {
    psql(`update artworks set created_at = now() - interval '2 days' where owner_id = '${E}'`); // earlier tests used today's upload limit
    put(E, `${E}/p1.webp`); put(E, `${E}/p1-thumb.webp`);
    [work] = publish(E, { image: `${E}/p1.webp`, thumb: `${E}/p1-thumb.webp`, title: 'Harbour' }).split('|');
    const edit = (who, id, availability = 'available', description = 'Oil on linen, 2026.') =>
      as(who, `select availability from update_artwork('${id}', 'Harbour at Dusk', 'oil', 'Realism', 'Oil on linen', 2026, 900, '${description}', '60 × 80 cm', '${availability}')`);
    assert.equal(edit(E, work, 'sold'), 'sold');
    assert.equal(psql(`select title || '|' || dimensions || '|' || price from artworks where id = '${work}'`), 'Harbour at Dusk|60 × 80 cm|900');
    fails(B, `select * from update_artwork('${work}', 'Mine now', 'oil', 'Realism', '', 2026, 10, '', '', 'available')`, /Not your artwork/);
    fails(E, `select * from update_artwork('${seed.artworks[0].id}', 'Catalog', 'oil', 'Realism', '', 2026, 10, '', '', 'available')`, /Not your artwork/);
    fails(E, `select * from update_artwork('${work}', 'Harbour', 'oil', 'Realism', '', 2026, 900, '', '', 'auction')`, /artworks_details_valid/);
    fails(E, `select * from update_artwork('${work}', 'Harbour', 'oil', 'Realism', '', 2026, 900, '${'x'.repeat(2001)}', '', 'available')`, /artworks_details_valid/);
    const snap = JSON.parse(as('anon', 'select community_snapshot()'));
    assert.equal(snap.uploads.find((u) => u.id === work).availability, 'sold');
    put(E, `${E}/p2.webp`); put(E, `${E}/p2-thumb.webp`);
    const [gone] = publish(E, { image: `${E}/p2.webp`, thumb: `${E}/p2-thumb.webp`, title: 'Gone' }).split('|');
    as(E, `select * from delete_artwork('${gone}')`);
    assert.equal(psql(`select details->>'title' from audit_events where action = 'artwork.deleted' and target_id = '${gone}'`), 'Gone');
  });

  await t.test('collections: private by default, owner-only writes, public ones shareable', () => {
    const id = as(A, `insert into collections (name) values ('Night skies') returning id`);
    as(A, `insert into collection_items (collection_id, artwork_id) values ('${id}', '${seed.artworks[5].id}'), ('${id}', '${work}')`);
    assert.equal(as(A, `select is_private from collections where id = '${id}'`), 't', 'private by default');
    for (const who of ['anon', B]) {
      assert.equal(as(who, `select count(*) from collections where id = '${id}'`), '0');
      assert.equal(as(who, `select count(*) from collection_items where collection_id = '${id}'`), '0');
      assert.equal(as(who, `select public_collection('${id}') is null`), 't');
    }
    fails(B, `insert into collection_items (collection_id, artwork_id) values ('${id}', '${seed.artworks[6].id}')`, /row-level security/);
    fails(B, `insert into collections (owner_id, name) values ('${A}', 'Planted')`, /row-level security/);
    noRowsFor(B, `with u as (update collections set name = 'Mine' where id = '${id}' returning 1) select count(*) from u`);
    noRowsFor(B, `with u as (delete from collections where id = '${id}' returning 1) select count(*) from u`);
    fails(A, `update collections set owner_id = '${B}' where id = '${id}'`, /permission denied/);
    as(A, `update collections set is_private = false, description = 'Blue hours' where id = '${id}'`);
    const shared = JSON.parse(as('anon', `select public_collection('${id}')`));
    assert.equal(shared.name, 'Night skies');
    assert.equal(shared.owner_name, 'Ana');
    assert.equal(shared.mine, false);
    assert.deepEqual(shared.items.sort(), [seed.artworks[5].id, work].sort());
    assert.equal(as(B, `select count(*) from collection_items where collection_id = '${id}'`), '2', 'public collections are readable');
    psql(`update artworks set hidden = true where id = '${work}'`);
    assert.deepEqual(JSON.parse(as('anon', `select public_collection('${id}')`)).items, [seed.artworks[5].id], 'moderated works drop out');
    psql(`update artworks set hidden = false where id = '${work}'`);
    fails(A, `insert into collections (name) values ('   ')`, /check constraint/);
    fails(A, `insert into collection_items (collection_id, artwork_id) values ('${id}', 'no-such-work')`, /foreign key/);
    as(A, `delete from collections where id = '${id}'`);
    assert.equal(psql(`select count(*) from collection_items where collection_id = '${id}'`), '0', 'items go with their collection');
  });

  // ——— Phase 2A (0007): ranking integrity, server-side scores, achievements ———
  const scoreOf = (id) => JSON.parse(as('anon', 'select community_snapshot()')).scores.find((x) => x.a === id) || { p: 0, t: 0, c: 0 };
  await t.test('your own likes, saves, follows, reviews and battle votes never count', () => {
    psql(`update artworks set created_at = now() - interval '2 days' where owner_id = '${E}'`);
    put(E, `${E}/own.webp`); put(E, `${E}/own-thumb.webp`);
    const [own] = publish(E, { image: `${E}/own.webp`, thumb: `${E}/own-thumb.webp`, title: 'Self' }).split('|');
    as(E, `insert into reactions (artwork_id, kind) values ('${own}', 'super')`);
    assert.equal(scoreOf(own).p, 0, 'a self-save adds nothing');
    as(A, `insert into reactions (artwork_id, kind) values ('${own}', 'like')`);
    const [anaRole, anaWeight] = psql(`select role || '|' || role_weight(role) from profiles where id = '${A}'`).split('|');
    assert.equal(scoreOf(own).p, Number(anaWeight), 'someone else’s like counts, at their role’s weight');
    const snap = JSON.parse(as('anon', 'select community_snapshot()'));
    assert.deepEqual(snap.reactions.filter((r) => r.a === own).map((r) => [r.k, r.r, r.n]), [['like', anaRole, 1]]);
    as(E, `insert into follows (artist_id) values ('m_${E}')`);
    assert.equal(JSON.parse(as('anon', 'select community_snapshot()')).follows.filter((f) => f.a === `m_${E}`).length, 0, 'following yourself adds nothing');
    const rival = seed.artworks[123];
    fails(E, `select * from cast_battle_vote('${own}', '${rival.id}')`, /your own work/);
    for (const who of ['anon', A]) for (const v of ['counted_reactions', 'counted_follows', 'counted_reviews']) noRowsFor(who, `select count(*) from ${v}`);
  });

  await t.test('server scores: popularity matches the app formula; trending halves every 7 days; collector interest is separate', () => {
    const snap = JSON.parse(as('anon', 'select community_snapshot()'));
    const c = snapshotToCommunity(snap);
    for (const row of snap.scores) {
      const counts = c.deltas[row.a];
      if (counts) assert.equal(row.p, artworkInfluence(counts), `popularity of ${row.a}`);
    }
    const w = seed.artworks[310];
    as(B, `insert into reactions (artwork_id, kind) values ('${w.id}', 'like')`);
    assert.equal(Number(scoreOf(w.id).t), 1);
    psql(`update reactions set created_at = now() - interval '7 days' where artwork_id = '${w.id}'`);
    assert.ok(Math.abs(Number(scoreOf(w.id).t) - 0.5) < 0.01, 'a week-old like counts half toward Trending');
    assert.equal(scoreOf(w.id).p, 1, 'all-time popularity is unchanged');
    assert.equal(scoreOf(w.id).c, 0, 'no collectors yet');
  });

  await t.test('members cannot exclude or un-exclude their own reactions', () => {
    const w = seed.artworks[311];
    as(B, `insert into reactions (artwork_id, kind, excluded) values ('${w.id}', 'like', true)`);
    assert.equal(psql(`select excluded from reactions where user_id = '${B}' and artwork_id = '${w.id}'`), 'f');
    psql(`update reactions set excluded = true, excluded_reason = 'test' where user_id = '${B}' and artwork_id = '${w.id}'`);
    as(B, `update reactions set excluded = false, kind = 'super' where artwork_id = '${w.id}'`);
    assert.equal(psql(`select excluded || '|' || kind from reactions where user_id = '${B}' and artwork_id = '${w.id}'`), 'true|super', 'kind changes; exclusion stays');
    assert.equal(scoreOf(w.id).p, 0, 'excluded reactions don’t count');
  });

  await t.test('rate limits: 600 likes and saves an hour', () => {
    const R = '00000000-0000-0000-0000-000000000301';
    psql(`insert into auth.users (id, email) values ('${R}', 'rapid@example.com')`);
    as(R, `insert into reactions (artwork_id, kind) select id, 'like' from artworks where owner_id is null order by id limit 600`);
    fails(R, `insert into reactions (artwork_id, kind) values ((select id from artworks where owner_id is not null limit 1), 'like')`, /Slow down/);
    psql(`update reactions set created_at = now() - interval '2 hours' where user_id = '${R}'`);
    as(R, `insert into reactions (artwork_id, kind) values ((select id from artworks where owner_id is not null limit 1), 'like')`);
    psql(`delete from auth.users where id = '${R}'`);
  });

  const NEW = Array.from({ length: 10 }, (_, i) => `00000000-0000-0000-0000-0000000004${String(i).padStart(2, '0')}`);
  await t.test('integrity: a burst from new accounts is flagged for moderators, who can exclude it (logged)', () => {
    const target = seed.artworks[400];
    psql(`insert into auth.users (id, email) values ${NEW.map((u, i) => `('${u}', 'new${i}@example.com')`).join(', ')}`);
    for (const u of NEW) as(u, `insert into reactions (artwork_id, kind) values ('${target.id}', 'like')`);
    assert.equal(scoreOf(target.id).p, 10);
    fails(P[0], 'select * from admin_integrity_queue()', /Admins only|permission denied/);
    fails(A, 'select detect_suspicious_activity()', /permission denied/);
    for (const who of ['anon', A]) noRowsFor(who, 'select count(*) from integrity_flags');
    const flag = as(P[1], `select id || '|' || (details->>'new_accounts') from admin_integrity_queue() where target_id = '${target.id}'`);
    const [flagId, fresh] = flag.split('|');
    assert.equal(fresh, '10');
    assert.equal(as(P[1], `select count(*) from admin_integrity_queue() where target_id = '${target.id}'`), '1', 'flagged once');
    fails(A, `select resolve_integrity_flag('${flagId}', true)`, /Admins only|permission denied/);
    assert.equal(as(P[1], `select resolve_integrity_flag('${flagId}', true, 'Coordinated new accounts')`), '10');
    assert.equal(scoreOf(target.id).p, 0, 'excluded from rankings');
    assert.equal(psql(`select count(*) from reactions where artwork_id = '${target.id}'`), '10', 'nothing is deleted');
    assert.equal(as(P[1], `select details->>'excluded' from admin_audit_log() where action = 'integrity_flag.confirmed' limit 1`), '10');
    fails(P[1], `select resolve_integrity_flag('${flagId}', false)`, /no longer open/);
  });

  await t.test('achievements: earned on the server with evidence; criteria public; artist achievements public, member ones private', () => {
    assert.ok(Number(as('anon', 'select count(*) from achievement_definitions')) >= 13, 'criteria are public');
    const mine = as(A, `select string_agg(code, ',' order by code) from my_achievements()`).split(',');
    assert.ok(mine.includes('first_discovery'));
    const eve = as(E, `select string_agg(code, ',' order by code) from my_achievements()`).split(',');
    assert.ok(eve.includes('first_work') && eve.includes('top_100_global'), eve.join());
    assert.equal(as(E, `select evidence->>'rank' from my_achievements() where code = 'top_100_global'`) !== '', true);
    const pub = as('anon', `select string_agg(code, ',' order by code) from artist_achievements('m_${E}')`).split(',');
    assert.ok(pub.includes('first_work') && !pub.includes('first_discovery'), 'only artist achievements are public');
    assert.equal(as(B, `select count(*) from member_achievements where user_id = '${A}'`), '0', 'others can’t read your achievements');
    noRowsFor(A, `with u as (insert into member_achievements (user_id, code) values ('${A}', 'master_critic') returning 1) select count(*) from u`);
    fails(A, 'select award_achievements()', /permission denied/);
    fails('anon', 'select * from my_achievements()', /permission denied|Sign in/);
  });

  // ——— Phase 2B (0008): Artist Arena and Creative Challenges ———
  const G = '00000000-0000-0000-0000-000000000501';
  const V = ['00000000-0000-0000-0000-000000000511', '00000000-0000-0000-0000-000000000512', '00000000-0000-0000-0000-000000000513'];
  let comp, eEntry, gEntry, eWork, gWork;
  const create = (who, kind = 'weekly', extra = {}) => {
    const x = { title: 'Blue Hour', category: '', country: '', open: "now() - interval '1 hour'", voting: "now() + interval '1 day'", close: "now() + interval '2 days'", ...extra };
    return as(who, `select id from create_competition('${kind}', '${x.title}', 'Paint the hour after rain.', 'One vote per member.', '${x.category}', '${x.country}', ${x.open}, ${x.voting}, ${x.close})`);
  };
  await t.test('competitions: only moderators create or cancel them; schedules and scope are validated', () => {
    fails(A, `select create_competition('weekly', 'Mine', '', '', '', '', now(), now() + interval '1 day', now() + interval '2 days')`, /Admins only|permission denied/);
    fails('anon', `select create_competition('weekly', 'Mine', '', '', '', '', now(), now() + interval '1 day', now() + interval '2 days')`, /permission denied/);
    fails(P[1], `select create_competition('weekly', 'Backwards', '', '', '', '', now(), now() - interval '1 day', now() + interval '2 days')`, /competitions_schedule/);
    fails(P[1], `select create_competition('category', 'No medium', '', '', '', '', now(), now() + interval '1 day', now() + interval '2 days')`, /competitions_scope/);
    comp = create(P[1]);
    assert.match(as(P[1], `select action from admin_audit_log() where action = 'competition.created' limit 1`), /competition\.created/);
    for (const who of ['anon', A]) noRowsFor(who, `with u as (insert into competitions (kind, title, entries_open_at, voting_opens_at, voting_closes_at) values ('weekly', 'Sneaky', now(), now() + interval '1 day', now() + interval '2 days') returning 1) select count(*) from u`);
    assert.equal(JSON.parse(as('anon', 'select arena()')).find((c) => c.id === comp).phase, 'entries');
  });

  await t.test('entries: one own published work per artist, while entries are open; eligibility enforced', () => {
    psql(`insert into auth.users (id, email) values ('${G}', 'gil@example.com'); update profiles set role = 'artist', country = 'PT' where id = '${G}'`);
    psql(`update artworks set created_at = now() - interval '2 days' where owner_id = '${E}'`);
    put(E, `${E}/c1.webp`); put(E, `${E}/c1-thumb.webp`);
    [eWork] = publish(E, { image: `${E}/c1.webp`, thumb: `${E}/c1-thumb.webp`, title: 'Rain' }).split('|');
    put(G, `${G}/g1.webp`); put(G, `${G}/g1-thumb.webp`);
    [gWork] = publish(G, { image: `${G}/g1.webp`, thumb: `${G}/g1-thumb.webp`, title: 'After Rain' }).split('|');
    eEntry = as(E, `select id from enter_competition('${comp}', '${eWork}')`);
    fails(E, `select enter_competition('${comp}', '${eWork}')`, /already have an entry/);
    fails(A, `select enter_competition('${comp}', '${gWork}')`, /your own published work/);
    fails(G, `select enter_competition('${comp}', '${seed.artworks[0].id}')`, /your own published work/, 'sample works can’t enter');
    fails('anon', `select enter_competition('${comp}', '${gWork}')`, /permission denied|Sign in/);
    gEntry = as(G, `select id from enter_competition('${comp}', '${gWork}')`);
    assert.equal(as(E, `select count(*) from my_achievements() where code = 'first_entry'`), '1');
    const photo = create(P[1], 'category', { title: 'Photography Week', category: 'photography' });
    fails(G, `select enter_competition('${photo}', '${gWork}')`, /different medium/);
    const fr = create(P[1], 'country', { title: 'Best of France', country: 'FR' });
    fails(G, `select enter_competition('${fr}', '${gWork}')`, /another country/);
    psql(`update artists set created_at = now() - interval '2 years' where owner_id = '${G}'`);
    const em = create(P[1], 'emerging', { title: 'New Voices' });
    fails(G, `select enter_competition('${em}', '${gWork}')`, /last 12 months/);
    psql(`update artists set created_at = now() where owner_id = '${G}'`);
    as(G, `select enter_competition('${em}', '${gWork}')`); // eligible again
    as(G, `select withdraw_entry('${em}')`);
    fails(G, `select withdraw_entry('${em}')`, /no entry/);
    noRowsFor(A, `with u as (insert into competition_entries (competition_id, artwork_id, user_id) values ('${comp}', '${gWork}', '${A}') returning 1) select count(*) from u`);
    fails(B, `select cast_competition_vote('${comp}', '${gEntry}')`, /Voting is not open/);
  });

  await t.test('voting: one vote per eligible member, changeable, never for yourself; totals hidden until close', () => {
    psql(`insert into auth.users (id, email) values ${V.map((v, i) => `('${v}', 'voter${i}@example.com')`).join(', ')}`);
    psql(`update competitions set voting_opens_at = now() - interval '1 minute' where id = '${comp}'`);
    fails(V[0], `select cast_competition_vote('${comp}', '${gEntry}')`, /after 3 days/);
    psql(`update profiles set created_at = now() - interval '4 days' where id in (${V.map((v) => `'${v}'`).join(', ')})`);
    fails(V[0], `select cast_competition_vote('${comp}', '${gEntry}')`, /at least 5 works/);
    psql(`insert into reactions (user_id, artwork_id, kind) select v, a.id, 'like' from unnest(array[${V.map((v) => `'${v}'::uuid`).join(', ')}]) v, (select id from artworks where owner_id is null order by id limit 5) a`);
    as(V[0], `select cast_competition_vote('${comp}', '${eEntry}')`);
    as(V[0], `select cast_competition_vote('${comp}', '${gEntry}')`); // changed their mind
    as(V[1], `select cast_competition_vote('${comp}', '${gEntry}')`);
    as(V[2], `select cast_competition_vote('${comp}', '${eEntry}')`);
    assert.equal(psql(`select count(*) from competition_votes where competition_id = '${comp}'`), '3', 'one vote per member');
    psql(`update profiles set created_at = now() - interval '4 days' where id = '${E}'`);
    psql(`insert into reactions (user_id, artwork_id, kind) select '${E}', id, 'like' from artworks where owner_id is null order by id desc limit 5 on conflict do nothing`);
    fails(E, `select cast_competition_vote('${comp}', '${eEntry}')`, /your own entry/);
    fails(E, `select enter_competition('${comp}', '${eWork}')`, /Entries are not open/);
    assert.equal(as(V[0], `select count(*) from competition_votes`), '1', 'you see only your own vote');
    noRowsFor('anon', `select count(*) from competition_votes`);
    const d = JSON.parse(as(B, `select competition_detail('${comp}')`));
    assert.equal(d.phase, 'voting');
    assert.equal(d.results, null, 'no totals while voting');
    assert.equal(d.entries.length, 2);
    assert.equal(JSON.parse(as(V[0], `select competition_detail('${comp}')`)).my_vote, gEntry);
    noRowsFor(V[0], `with u as (update competition_votes set entry_id = '${eEntry}' returning 1) select count(*) from u`);
  });

  await t.test('closing: places (ties share), achievements, and notifications to entrants and followers', () => {
    as(B, `insert into follows (artist_id) values ('m_${G}')`);
    psql(`update competitions set voting_closes_at = now() - interval '1 second' where id = '${comp}'`);
    const arena = JSON.parse(as('anon', 'select arena()'));
    const c = arena.find((x) => x.id === comp);
    assert.equal(c.phase, 'closed');
    assert.equal(c.winner, gWork);
    const d = JSON.parse(as('anon', `select competition_detail('${comp}')`));
    assert.deepEqual(d.results.entries.map((r) => [r.artwork, r.votes, r.place]), [[gWork, 2, 1], [eWork, 1, 2]]);
    assert.equal(d.results.voters, 3);
    assert.equal(as(G, `select string_agg(code, ',' order by code) from my_achievements() where code in ('competition_winner', 'podium_finish')`), 'competition_winner,podium_finish');
    assert.equal(as(E, `select string_agg(code, ',' order by code) from my_achievements() where code in ('competition_winner', 'podium_finish')`), 'podium_finish');
    assert.match(as('anon', `select string_agg(code, ',') from artist_achievements('m_${G}')`), /competition_winner/);
    assert.match(as(E, `select title from notifications`), /placed 2nd in “Blue Hour”/);
    assert.match(as(G, `select title from notifications`), /placed 1st/);
    assert.match(as(B, `select title from notifications`), /won “Blue Hour”/);
    assert.equal(as(A, `select count(*) from notifications where user_id = '${E}'`), '0', 'notifications are private');
    as(E, 'select mark_notifications_read()');
    assert.equal(as(E, `select count(*) from notifications where read_at is null`), '0');
    as('anon', 'select arena()');
    assert.equal(psql(`select count(*) from notifications where title like '%Blue Hour%'`), '3', 'results are announced once');
    fails(V[0], `select cast_competition_vote('${comp}', '${eEntry}')`, /Voting is not open/);
    // A tie shares the place.
    const tie = create(P[1], 'challenge', { title: 'Tie Break' });
    const te = as(E, `select id from enter_competition('${tie}', '${eWork}')`);
    const tg = as(G, `select id from enter_competition('${tie}', '${gWork}')`);
    psql(`update competitions set voting_opens_at = now() - interval '1 minute' where id = '${tie}'`);
    as(V[0], `select cast_competition_vote('${tie}', '${te}')`);
    as(V[1], `select cast_competition_vote('${tie}', '${tg}')`);
    psql(`update competitions set voting_closes_at = now() - interval '1 second' where id = '${tie}'`);
    assert.deepEqual(JSON.parse(as('anon', `select competition_detail('${tie}')`)).results.entries.map((r) => r.place), [1, 1]);
    assert.equal(as(E, `select count(*) from my_achievements() where code = 'competition_winner'`), '1', 'a shared first place wins');
  });

  await t.test('cancelled competitions take no entries and are logged', () => {
    const x = create(P[1], 'daily', { title: 'Called Off' });
    fails(A, `select cancel_competition('${x}')`, /Admins only|permission denied/);
    as(P[1], `select cancel_competition('${x}', 'Wrong dates')`);
    fails(E, `select enter_competition('${x}', '${eWork}')`, /Entries are not open/);
    assert.equal(JSON.parse(as('anon', 'select arena()')).find((c) => c.id === x).phase, 'cancelled');
    assert.match(as(P[1], `select details->>'note' from admin_audit_log() where action = 'competition.cancelled' limit 1`), /Wrong dates/);
    fails(P[1], `select cancel_competition('${comp}')`, /already ended/);
  });

  // ——— Phase 3 (0009): Studio analytics and weekly reports ———
  const GUEST = 'guest-key-0123456789abcdef';
  let eArt;
  const rec = (who, events, guest = null) => Number(as(who, `select record_events('${JSON.stringify(events)}'::jsonb, ${guest ? `'${guest}'` : 'null'})`));
  await t.test('events: once per viewer per day, never your own, guests separate, sample works ignored, no direct access', () => {
    eArt = psql(`select id from artworks where owner_id = '${E}' and not hidden order by id limit 1`); // (several share a timestamp)
    const evs = [{ k: 'impression', t: eArt }, { k: 'artwork_view', t: eArt }, { k: 'profile_visit', t: `m_${E}` }];
    assert.equal(rec(B, evs), 3);
    assert.equal(rec(B, evs), 0, 'once per day');
    assert.equal(rec(E, evs), 0, 'your own views never count');
    assert.equal(rec(B, [{ k: 'artwork_view', t: seed.artworks[3].id }]), 0, 'sample works have nobody to report to');
    assert.equal(rec('anon', evs, GUEST), 3, 'guests count, by device key');
    assert.equal(rec('anon', evs, 'bad key!'), 0);
    assert.equal(rec('anon', evs), 0, 'guests need a key');
    assert.equal(rec(B, [{ k: 'hack', t: eArt }, { k: 'artwork_view', t: 'no-such-work' }]), 0);
    fails(B, `select record_events('${JSON.stringify(Array.from({ length: 101 }, () => ({ k: 'impression', t: eArt })))}'::jsonb)`, /up to 100/);
    for (const who of ['anon', B, E]) noRowsFor(who, 'select count(*) from analytics_events');
    noRowsFor(B, `with u as (insert into analytics_events (kind, target_id, artist_id, viewer_id) values ('artwork_view', '${eArt}', 'm_${E}', '${B}') returning 1) select count(*) from u`);
    fails(B, `select artist_summary('m_${E}', now() - interval '1 day', now())`, /permission denied/);
  });

  await t.test('rate limit: 2,000 events an hour per viewer', () => {
    const key = 'flood-key-0123456789abcd';
    psql(`insert into analytics_events (kind, target_id, artist_id, guest_key) select 'impression', 'x' || g, 'm_${E}', '${key}' from generate_series(1, 2000) g`);
    assert.equal(rec('anon', [{ k: 'artwork_view', t: eArt }], key), 0);
  });

  await t.test('studio: the artist sees their own totals (members and guests apart), never anyone else’s', () => {
    const st = JSON.parse(as(E, 'select studio_analytics(7)'));
    assert.equal(st.days, 7);
    assert.deepEqual(st.current.views, { members: 1, guests: 1 });
    assert.deepEqual(st.current.visits, { members: 1, guests: 1 });
    assert.equal(st.daily.length, 7);
    assert.equal(st.daily.at(-1).views, 2);
    const w = st.works.find((x) => x.id === eArt);
    assert.equal(w.views, 2);
    assert.ok(st.countries.every((c) => c.people >= 3 || c.country === 'Other'), 'small countries are grouped');
    assert.equal(JSON.stringify(st).includes(B), false, 'never who');
    assert.equal(as(B, 'select studio_analytics(30) is null'), 't', 'no artist page, no studio');
    fails('anon', 'select studio_analytics(30)', /permission denied|Sign in/);
    assert.equal(JSON.parse(as(E, 'select studio_analytics(12345)')).days, 30, 'periods are 7, 30 or 90 days');
  });

  await t.test('audience by country appears once 3 or more people share it', () => {
    const CC = ['00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000603'];
    psql(`insert into auth.users (id, email) values ${CC.map((u, i) => `('${u}', 'jp${i}@example.com')`).join(', ')}; update profiles set country = 'JP' where id in (${CC.map((u) => `'${u}'`).join(', ')})`);
    for (const u of CC) rec(u, [{ k: 'artwork_view', t: eArt }]);
    const st = JSON.parse(as(E, 'select studio_analytics(7)'));
    assert.equal(st.countries.find((c) => c.country === 'JP')?.people, 3);
  });

  await t.test('weekly reports: last week’s report and a notification, once; private to the artist', () => {
    psql(`update artworks set created_at = now() - interval '20 days' where id = '${eArt}'`);
    const first = as(E, `select count(*) from my_weekly_reports()`);
    assert.equal(first, '1');
    assert.equal(as(E, `select count(*) from my_weekly_reports()`), '1', 'made once');
    assert.equal(as(E, `select count(*) from notifications where kind = 'weekly_report'`), '1');
    assert.equal(as(B, `select count(*) from weekly_reports where user_id = '${E}'`), '0');
    fails(B, 'select generate_weekly_reports()', /permission denied/);
    const r = JSON.parse(as(E, `select row_to_json(x) from my_weekly_reports() x limit 1`));
    assert.ok('views' in r.current && 'followers' in r.previous);
    assert.equal(new Date(r.week_start).getUTCDay(), 1, 'weeks start on Monday');
  });

  // ——— Phase 4 (0010): Collector Radar and Drops ———
  let inq;
  await t.test('inquiries: members 3+ days old start real conversations that only the two of them can read', () => {
    psql(`update artworks set availability = 'available' where id = '${eArt}'; update profiles set created_at = now() where id = '${B}'`);
    fails(B, `select send_inquiry('${eArt}', null, 'purchase', 'Is this still available?')`, /after 3 days/);
    psql(`update profiles set created_at = now() - interval '10 days' where id = '${B}'`);
    fails(B, `select send_inquiry('${seed.artworks[0].id}', null, 'question', 'Hello there, lovely work.')`, /Sample artists can’t be contacted/);
    fails(E, `select send_inquiry('${eArt}', null, 'purchase', 'Buying my own work?')`, /your own work/);
    fails(B, `select send_inquiry('${eArt}', null, 'purchase', 'Hi')`, /at least 10 characters/);
    inq = as(B, `select send_inquiry('${eArt}', null, 'purchase', 'Is this still available? I love the light in it.')`);
    fails(B, `select send_inquiry('${eArt}', null, 'purchase', 'Asking again about this work.')`, /already have an open conversation/);
    as(B, `select send_inquiry(null, 'm_${E}', 'commission', 'Would you paint my harbour at dusk?')`);
    fails(B, `select send_inquiry(null, 'm_${E}', 'purchase', 'Buy something, anything please.')`, /Choose a work/);
    assert.match(as(E, `select title from notifications where kind = 'inquiry' order by created_at limit 1`), /sent you a purchase inquiry about/);
    const mine = JSON.parse(as(E, 'select my_inquiries()'));
    assert.equal(mine.length, 2);
    assert.equal(mine[0].side, 'artist');
    assert.equal(mine.find((q) => q.id === inq).unread, true);
    assert.deepEqual(Object.keys(mine[0]).filter((k) => /email|other_id/.test(k)), [], 'no contact details');
    for (const who of [A, 'anon']) {
      noRowsFor(who, `select count(*) from inquiries where id = '${inq}'`);
      noRowsFor(who, `select count(*) from inquiry_messages where inquiry_id = '${inq}'`);
    }
    assert.equal(as(A, `select inquiry_thread('${inq}') is null`), 't');
    fails(A, `select reply_inquiry('${inq}', 'Butting in')`, /not found/);
    noRowsFor(B, `with u as (insert into inquiry_messages (inquiry_id, sender_id, body) values ('${inq}', '${E}', 'Forged') returning 1) select count(*) from u`);
    noRowsFor(B, `with u as (update inquiries set status = 'declined' returning 1) select count(*) from u`);
  });

  await t.test('inquiries: replies, unread state, one notification per unread stretch, decline and close', () => {
    as(E, `select reply_inquiry('${inq}', 'Yes, it is. It is 60 by 80 cm.')`);
    as(E, `select reply_inquiry('${inq}', 'Happy to send more photos.')`);
    assert.equal(as(B, `select count(*) from notifications where kind = 'inquiry_reply'`), '1', 'not one per message');
    let th = JSON.parse(as(B, `select inquiry_thread('${inq}')`));
    assert.deepEqual(th.messages.map((m) => m.mine), [true, false, false]);
    assert.equal(JSON.parse(as(B, 'select my_inquiries()')).find((q) => q.id === inq).unread, true);
    as(B, `select mark_inquiry_read('${inq}')`);
    assert.equal(JSON.parse(as(B, 'select my_inquiries()')).find((q) => q.id === inq).unread, false);
    fails(B, `select set_inquiry_status('${inq}', 'declined')`, /Only the artist can decline/);
    as(E, `select set_inquiry_status('${inq}', 'declined')`);
    fails(B, `select reply_inquiry('${inq}', 'But why?')`, /closed/);
    th = JSON.parse(as(E, `select inquiry_thread('${inq}')`));
    assert.equal(th.status, 'declined');
  });

  await t.test('inquiries: blocking, reporting (moderators see only reported conversations), daily limit, collector interest', () => {
    const q2 = as(B, `select send_inquiry('${eArt}', null, 'question', 'One more question about the framing?')`);
    as(B, `select report_inquiry('${q2}', 'Testing the report flow')`);
    fails(A, 'select admin_inquiry_reports()', /Admins only|permission denied/);
    const reports = JSON.parse(as(P[1], 'select admin_inquiry_reports()'));
    assert.equal(reports.length, 1);
    assert.match(reports[0].messages[0].body, /framing/);
    as(P[1], `select resolve_inquiry_report('${reports[0].id}', true, 'Closed after review')`);
    assert.equal(as(B, `select status from inquiries where id = '${q2}'`), 'closed');
    assert.match(as(P[1], `select action from admin_audit_log() where action like 'inquiry_report.%' limit 1`), /inquiry_report\.closed/);
    as(E, `select set_block('${q2}', true)`);
    fails(B, `select send_inquiry('${eArt}', null, 'question', 'Are you there? Hello again.')`, /can’t contact this member/);
    as(E, `select set_block('${q2}', false)`);
    psql(`insert into inquiries (artist_id, artist_user, sender_id, kind) select 'm_${G}', '${G}', '${V[2]}', 'question' from generate_series(1, 10)`);
    psql(`update profiles set created_at = now() - interval '10 days' where id = '${V[2]}'`);
    fails(V[2], `select send_inquiry('${eArt}', null, 'question', 'An eleventh conversation today.')`, /10 conversations a day/);
    psql(`update profiles set role = 'collector' where id = '${V[1]}'`);
    as(V[1], `insert into reactions (artwork_id, kind) values ('${eArt}', 'super') on conflict (user_id, artwork_id) do update set kind = 'super'`);
    const ci = JSON.parse(as(E, 'select collector_interest()')).find((x) => x.artwork === eArt);
    assert.equal(ci.inquiries, 2);
    assert.ok(ci.collector_saves >= 1);
    assert.equal(JSON.stringify(ci).includes(V[1]), false, 'counts only');
  });

  let drop, dropWork;
  await t.test('drops: scheduled works stay hidden until release; followers and subscribers are notified once', () => {
    psql(`update artworks set created_at = now() - interval '2 days' where owner_id = '${E}'`);
    put(E, `${E}/d1.webp`); put(E, `${E}/d1-thumb.webp`);
    [dropWork] = publish(E, { image: `${E}/d1.webp`, thumb: `${E}/d1-thumb.webp`, title: 'Night Swim' }).split('|');
    as(V[0], `insert into follows (artist_id) values ('m_${E}') on conflict do nothing`);
    fails(E, `select create_drop('Too soon', '', now() + interval '1 minute', array['${dropWork}'])`, /10 minutes and 60 days/);
    fails(E, `select create_drop('Not mine', '', now() + interval '1 hour', array['${gWork}'])`, /only your own works/);
    fails(B, `select create_drop('No works', '', now() + interval '1 hour', array['${dropWork}'])`, /Publish a work first/);
    drop = as(E, `select create_drop('Summer Night', 'Three new paintings.', now() + interval '1 hour', array['${dropWork}'])`);
    assert.match(as(V[0], `select title from notifications where kind = 'drop_announced'`), /announced a drop: “Summer Night”/);
    for (const who of ['anon', A]) assert.equal(as(who, `select count(*) from artworks where id = '${dropWork}'`), '0', 'hidden before release');
    assert.equal(as(E, `select count(*) from artworks where id = '${dropWork}'`), '1', 'the artist still sees it');
    assert.equal(JSON.parse(as('anon', 'select community_snapshot()')).uploads.some((u) => u.id === dropWork), false);
    fails(A, `insert into reactions (artwork_id, kind) values ('${dropWork}', 'like')`, /hasn’t been released/);
    const d = JSON.parse(as('anon', `select drop_detail('${drop}')`));
    assert.equal(d.phase, 'upcoming');
    assert.deepEqual(d.works, [], 'works stay secret');
    assert.equal(d.teaser_thumb, null, 'no teaser image for the public before release (0014)');
    assert.ok(JSON.parse(as(E, `select drop_detail('${drop}')`)).teaser_thumb, 'the artist sees it');
    assert.deepEqual(JSON.parse(as(E, `select drop_detail('${drop}')`)).works, [dropWork]);
    as(A, `select subscribe_drop('${drop}', true)`);
    fails(A, `select cancel_drop('${drop}')`, /Only the artist or a moderator/);
    psql(`update drops set release_at = now() - interval '1 second' where id = '${drop}'; update artworks set release_at = now() - interval '1 second' where id = '${dropWork}'`);
    const overview = JSON.parse(as('anon', 'select drops_overview()'));
    assert.equal(overview.find((x) => x.id === drop).phase, 'released');
    as('anon', 'select drops_overview()');
    assert.equal(as(A, `select count(*) from notifications where kind = 'drop_released'`), '1', 'subscribers, once');
    assert.equal(as(V[0], `select count(*) from notifications where kind = 'drop_released'`), '1', 'followers, once');
    assert.equal(as('anon', `select count(*) from artworks where id = '${dropWork}'`), '1', 'visible after release');
    as(A, `insert into reactions (artwork_id, kind) values ('${dropWork}', 'like')`);
  });

  await t.test('drops: upcoming drops are limited by plan (Free 1, Pro 3); moderators can cancel (recorded), which makes the works visible', () => {
    const works = [];
    for (let i = 0; i < 4; i++) {
      put(E, `${E}/x${i}.webp`); put(E, `${E}/x${i}-thumb.webp`);
      [works[i]] = publish(E, { image: `${E}/x${i}.webp`, thumb: `${E}/x${i}-thumb.webp`, title: `Lot ${i}` }).split('|');
    }
    const first = as(E, `select create_drop('Drop 0', '', now() + interval '2 hours', array['${works[0]}'])`);
    fails(E, `select create_drop('Drop 1', '', now() + interval '2 hours', array['${works[1]}'])`, /allows 1 upcoming drop at a time/);
    as(P[1], `select admin_grant_plan('${E}', 'pro', current_date + 30, 'Beta tester')`);
    const ids = [first, ...works.slice(1, 3).map((w, i) => as(E, `select create_drop('Drop ${i + 1}', '', now() + interval '2 hours', array['${w}'])`))];
    fails(E, `select create_drop('Drop 4', '', now() + interval '2 hours', array['${works[3]}'])`, /allows 3 upcoming drops/);
    as(P[1], `select admin_revoke_plan('${E}')`);
    fails(E, `select create_drop('Twice', '', now() + interval '2 hours', array['${works[0]}'])`, /another upcoming drop|upcoming drop/);
    as(P[1], `select cancel_drop('${ids[0]}', 'Duplicate')`);
    assert.equal(as('anon', `select count(*) from artworks where id = '${works[0]}'`), '1');
    assert.match(as(P[1], `select details->>'note' from admin_audit_log() where action = 'drop.cancelled' limit 1`), /Duplicate/);
    as(E, `select cancel_drop('${ids[1]}')`);
    fails(E, `select cancel_drop('${ids[1]}')`, /already been released or cancelled/);
  });

  // ——— Phase 5 (0011): Career Coach, Artist Passport, Gallery Opportunities ———
  let opp;
  await t.test('opportunities: moderators publish; members suggest for review; only approved listings are public; saves and reminders', () => {
    const args = (title, deadline = "current_date + 10", fee = 0) => `'open_call', '${title}', 'Galeria Norte', 'Lisbon, Portugal', ${deadline}, 'Painters under 35', 'Group show in spring.', ${fee}, 'EUR', 'https://galerianorte.example/call'`;
    opp = as(P[1], `select suggest_opportunity(${args('Spring Open Call')})`);
    assert.equal(as('anon', `select count(*) from opportunities where id = '${opp}'`), '1', 'moderator listings are published directly');
    psql(`update profiles set created_at = now() where id = '${C}'`);
    fails(C, `select suggest_opportunity(${args('Too new')})`, /after 3 days/);
    psql(`update profiles set created_at = now() - interval '10 days' where id = '${C}'`);
    fails(C, `select suggest_opportunity(${args('Past', 'current_date - 1')})`, /deadline has passed/);
    fails(C, `select suggest_opportunity('open_call', 'Bad link', 'X', 'Y', current_date + 5, '', '', 0, 'USD', 'http://insecure.example')`, /opportunities_link_check|check constraint/);
    const sug = as(C, `select suggest_opportunity(${args('Members Suggest', 'current_date + 20', 25)})`);
    assert.equal(as('anon', `select count(*) from opportunities where id = '${sug}'`), '0', 'pending suggestions are not public');
    assert.equal(as(C, `select count(*) from opportunities where id = '${sug}'`), '1', 'the suggester sees their own');
    fails(C, `select review_opportunity('${sug}', true)`, /Admins only|permission denied/);
    assert.equal(JSON.parse(as(P[1], 'select admin_opportunity_queue()')).some((o) => o.id === sug), true);
    as(P[1], `select review_opportunity('${sug}', true, 'Checked with the gallery')`);
    const list = JSON.parse(as('anon', 'select opportunities_list()'));
    assert.equal(list.find((o) => o.id === sug).fee, 25, 'fees are shown');
    noRowsFor(C, `with u as (insert into opportunities (kind, title, organizer, location, deadline, link, status) values ('prize', 'Forged', 'X', 'Y', current_date + 3, 'https://x.example', 'approved') returning 1) select count(*) from u`);
    as(B, `select save_opportunity('${opp}', true)`);
    assert.equal(JSON.parse(as(B, 'select opportunities_list()')).find((o) => o.id === opp).saved, true);
    psql(`update opportunities set deadline = current_date + 2 where id = '${opp}'`);
    assert.equal(psql('select send_deadline_reminders()'), '1');
    assert.equal(psql('select send_deadline_reminders()'), '0', 'once');
    assert.match(as(B, `select title from notifications where kind = 'opportunity_deadline'`), /Spring Open Call” closes/);
    fails(B, 'select send_deadline_reminders()', /permission denied/);
    assert.match(as(P[1], `select string_agg(action, ',') from admin_audit_log() where action like 'opportunity.%'`), /opportunity\.approved/);
  });

  await t.test('coach: Pro and Elite artists only, their own data as context, the plan’s monthly limit (failed requests don’t count), no direct writes', () => {
    fails(B, `select begin_coach_request('bio')`, /for artists/);
    fails(E, `select begin_coach_request('bio')`, /comes with Artist Pro and Elite/);
    as(P[1], `select admin_grant_plan('${E}', 'pro', current_date + 30)`);
    fails('anon', `select begin_coach_request('bio')`, /permission denied|Sign in/);
    fails(E, `select begin_coach_request('hack')`, /Unknown Coach tool/);
    fails(E, `select begin_coach_request('description', '${gWork}')`, /your own works/);
    fails(E, `select begin_coach_request('application', null, gen_random_uuid())`, /listed opportunity/);
    const ctx = JSON.parse(as(E, `select begin_coach_request('description', '${eArt}')`));
    assert.equal(ctx.artwork.id, eArt);
    assert.ok(ctx.works.length > 0 && ctx.works.every((w) => w.title));
    assert.equal(JSON.stringify(ctx).includes(G), false, 'no one else’s data');
    as(E, `select finish_coach_request('${ctx.request_id}', false)`);
    assert.equal(JSON.parse(as(E, 'select coach_usage()')).used, 0, 'failed requests don’t count');
    const eng = JSON.parse(as(E, `select begin_coach_request('engagement')`));
    assert.ok('views' in eng.stats.last_30_days);
    as(E, `select finish_coach_request('${eng.request_id}', true)`);
    const app = JSON.parse(as(E, `select begin_coach_request('application', null, '${opp}')`));
    assert.equal(app.opportunity.title, 'Spring Open Call');
    psql(`insert into coach_requests (user_id, tool, status) select '${E}', 'bio', 'done' from generate_series(1, 58)`);
    fails(E, `select begin_coach_request('bio')`, /60 Coach requests/);
    assert.equal(JSON.parse(as(E, 'select coach_usage()')).used, 60);
    noRowsFor(E, `with u as (delete from coach_requests returning 1) select count(*) from u`);
    noRowsFor(B, `select count(*) from coach_requests where user_id = '${E}'`);
    as(P[1], `select admin_revoke_plan('${E}')`);
    psql(`update coach_requests set created_at = created_at - interval '40 days' where user_id = '${E}'`); // last month's
  });

  await t.test('passport: exhibitions show only once a moderator verifies them; history and milestones come from records', () => {
    fails(B, `select submit_exhibition('solo', 'Tides', 'Galeria Norte', 'Lisbon', 'PT', current_date - 30, current_date - 1, 'https://galerianorte.example/tides')`, /Publish a work first/);
    fails(E, `select submit_exhibition('solo', 'Tides', 'Galeria Norte', 'Lisbon', 'PT', current_date - 30, current_date - 1, 'http://insecure.example')`, /check constraint/);
    const ex = as(E, `select submit_exhibition('solo', 'Tides', 'Galeria Norte', 'Lisbon', 'PT', current_date - 30, current_date - 1, 'https://galerianorte.example/tides')`);
    let pass = JSON.parse(as('anon', `select artist_passport('m_${E}')`));
    assert.equal(pass.exhibitions.length, 0, 'pending exhibitions aren’t shown');
    assert.equal(as(E, `select count(*) from exhibitions where id = '${ex}'`), '1', 'the artist sees their own');
    fails(E, `select review_exhibition('${ex}', true)`, /Admins only|permission denied/);
    noRowsFor(E, `with u as (update exhibitions set status = 'verified' returning 1) select count(*) from u`);
    as(P[1], `select review_exhibition('${ex}', true, 'Confirmed on the gallery site')`);
    pass = JSON.parse(as('anon', `select artist_passport('m_${E}')`));
    assert.equal(pass.exhibitions[0].title, 'Tides');
    assert.ok(pass.achievements.some((a) => a.label === 'First Work'));
    assert.ok(pass.competitions.some((c) => c.place === 2), 'Blue Hour, 2nd');
    assert.ok(pass.milestones.joined && pass.milestones.first_work && pass.milestones.first_inquiry);
    assert.match(as(E, `select title from notifications where kind = 'exhibition_review'`), /verified on your Passport/);
    assert.equal(as('anon', `select artist_passport('${seed.artists[0].id}') is null`), 't', 'sample artists have no Passport');
    const ex2 = as(E, `select submit_exhibition('group', 'Unverifiable', 'Nowhere', null, null, current_date - 10, null, 'https://example.org/x')`);
    as(P[1], `select review_exhibition('${ex2}', false, 'No record found')`);
    assert.match(as(E, `select title from notifications where kind = 'exhibition_review' order by created_at desc limit 1`), /couldn’t be verified: No record found/);
    as(E, `select delete_exhibition('${ex2}')`);
    fails(B, `select delete_exhibition('${ex}')`, /Not your exhibition/);
  });

  // ——— Phase 6 (0012): plans, galleries, beta tools, billing hooks ———
  await t.test('plans: the catalog matches the app; Free by default; moderator grants are audited, end-dated and lift the limits', () => {
    const plans = JSON.parse(as('anon', `select json_agg(row_to_json(p) order by p.sort) from plans p`));
    assert.deepEqual(plans, PLANS, 'supabase plans = src/core/plans.js');
    assert.equal(JSON.parse(as(E, 'select my_plan()')).plan.code, 'free');
    assert.equal(JSON.parse(as(E, 'select coach_usage()')).limit, 0, 'the Coach is a Pro and Elite feature');
    fails(E, `select begin_coach_request('bio')`, /comes with Artist Pro and Elite/);
    fails(E, 'select studio_analytics(365)', /Artist Pro and Elite/);
    fails(E, `select admin_grant_plan('${E}', 'elite', current_date + 30)`, /Admins only|permission denied/);
    fails(P[1], `select admin_grant_plan('${E}', 'pro', current_date)`, /between tomorrow and a year/);
    fails(P[1], `select admin_grant_plan('${E}', 'pro', current_date + 400)`, /between tomorrow and a year/);
    fails(P[1], `select admin_grant_plan('${E}', 'gallery', current_date + 30)`, /verified galleries/);
    fails(P[1], `select admin_grant_plan('${E}', 'free', current_date + 30)`, /Pro, Elite or Gallery/);
    noRowsFor(E, `with u as (insert into subscriptions (user_id, plan, status, source, current_period_end) values ('${E}', 'elite', 'active', 'grant', now() + interval '1 year') returning 1) select count(*) from u`);
    as(P[1], `select admin_grant_plan('${E}', 'pro', current_date + 30, 'Beta tester')`);
    const mine = JSON.parse(as(E, 'select my_plan()'));
    assert.equal(mine.plan.code, 'pro');
    assert.equal(mine.source, 'grant');
    assert.equal(JSON.parse(as(E, 'select coach_usage()')).limit, 60);
    const ctx = JSON.parse(as(E, `select begin_coach_request('bio')`));
    as(E, `select finish_coach_request('${ctx.request_id}', true)`);
    const year = JSON.parse(as(E, 'select studio_analytics(365)'));
    assert.equal(year.days, 365);
    assert.equal(year.daily.length, 365);
    noRowsFor(E, `with u as (update subscriptions set plan = 'elite' returning 1) select count(*) from u`);
    noRowsFor(B, `select count(*) from subscriptions where user_id = '${E}'`);
    assert.equal(JSON.parse(as('anon', 'select plan_badges()'))[`m_${E}`], 'Pro', 'the badge is public');
    assert.match(as(E, `select title from notifications where kind = 'plan_granted'`), /Artist Pro until/);
    assert.match(as(P[1], `select details->>'plan' from admin_audit_log() where action = 'plan.granted' limit 1`), /pro/);
    assert.ok(JSON.parse(as(P[1], 'select admin_plan_holders()')).some((h) => h.name && h.plan === 'pro'));
    assert.ok(JSON.parse(as(P[1], `select admin_find_members('${psql(`select name from profiles where id = '${E}'`).slice(0, 4)}')`)).length > 0);
    psql(`update subscriptions set current_period_end = now() - interval '1 second' where user_id = '${E}'`);
    assert.equal(JSON.parse(as(E, 'select my_plan()')).plan.code, 'free', 'grants lapse on their end date');
    assert.equal(JSON.parse(as('anon', 'select plan_badges()'))[`m_${E}`], undefined);
    as(P[1], `select admin_grant_plan('${E}', 'elite', current_date + 7)`);
    as(P[1], `select admin_revoke_plan('${E}', 'Test over')`);
    assert.equal(JSON.parse(as(E, 'select my_plan()')).plan.code, 'free');
    fails(P[1], `select admin_revoke_plan('${E}')`, /No granted plan/);
  });

  await t.test('plans never change rankings: scores are identical before and after a plan, and no ranking function reads plans', () => {
    const scores = `select md5(coalesce((select json_agg(x order by x.artwork_id)::text from artwork_scores() x), '')) || md5(coalesce((select json_agg(x order by x.artist_id)::text from artist_scores() x), '')) || md5(community_snapshot()::text) || md5(member_leaderboards()::text)`;
    // One transaction (one clock), so time-decayed scores are comparable; rolled back afterwards.
    const [before, after] = psql(`begin; ${scores}; insert into subscriptions (user_id, plan, status, source, current_period_end)
      values ('${E}', 'elite', 'active', 'grant', now() + interval '30 days'), ('${G}', 'elite', 'active', 'grant', now() + interval '30 days'); ${scores}; rollback;`).split('\n');
    assert.ok(before.length === 128 && before === after, 'same scores, snapshot and boards');
    const readers = psql(`select string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('artwork_scores', 'artist_scores', 'community_snapshot', 'member_leaderboards', 'cast_battle_vote',
        'cast_competition_vote', 'finalize_competition', 'award_achievements', 'detect_suspicious_activity')
        and p.prosrc ~* '(subscriptions|current_plan|plans\\b|plan_badges)'`);
    assert.equal(readers, '', 'ranking functions must not read plans');
  });

  await t.test('exhibitions from Elite artists are reviewed first; the checks are the same', () => {
    const plain = as(E, `select submit_exhibition('group', 'Plain', 'Room 1', null, null, current_date - 5, null, 'https://example.org/plain')`);
    as(P[1], `select admin_grant_plan('${E}', 'elite', current_date + 30)`);
    const q = JSON.parse(as(P[1], 'select admin_exhibition_queue()'));
    assert.equal(q[0].priority, true);
    as(P[1], `select admin_revoke_plan('${E}')`);
    as(E, `select delete_exhibition('${plain}')`);
  });

  let gal;
  await t.test('galleries: members apply, moderators verify (audited, notified); verified galleries are public; the Gallery plan posts directly', () => {
    psql(`update profiles set created_at = now() where id = '${B}'`);
    fails(B, `select apply_gallery('New Space', 'Porto', 'PT', 'https://newspace.example', '')`, /after 3 days/);
    psql(`update profiles set created_at = now() - interval '30 days' where id = '${B}'`);
    fails(C, `select apply_gallery('Casa do Mar', 'Porto', 'PT', 'http://insecure.example', '')`, /check constraint/);
    gal = as(C, `select apply_gallery('Casa do Mar', 'Porto', 'pt', 'https://casadomar.example', 'A gallery by the sea.')`);
    assert.equal(as('anon', `select count(*) from galleries where id = '${gal}'`), '0', 'pending galleries are not public');
    assert.equal(as('anon', `select gallery_page('${gal}') is null`), 't');
    assert.equal(JSON.parse(as(C, 'select my_gallery()')).status, 'pending');
    noRowsFor(C, `with u as (update galleries set status = 'verified' returning 1) select count(*) from u`);
    fails(C, `select review_gallery('${gal}', true)`, /Admins only|permission denied/);
    assert.ok(JSON.parse(as(P[1], 'select admin_gallery_queue()')).some((g) => g.id === gal && g.member));
    as(P[1], `select review_gallery('${gal}', true, 'Checked the website')`);
    assert.equal(JSON.parse(as('anon', `select gallery_page('${gal}')`)).name, 'Casa do Mar');
    assert.match(as(C, `select title from notifications where kind = 'gallery_review'`), /now a verified gallery/);
    assert.match(as(P[1], `select string_agg(action, ',') from admin_audit_log() where action like 'gallery.%'`), /gallery\.verified/);
    const args = (title) => `'residency', '${title}', 'ignored', 'Porto', current_date + 20, '', '', 0, 'EUR', 'https://casadomar.example/${title.length}'`;
    const pending = as(C, `select suggest_opportunity(${args('Sea Studio')})`);
    assert.equal(as('anon', `select count(*) from opportunities where id = '${pending}'`), '0', 'without the Gallery plan, listings wait for review');
    assert.equal(psql(`select organizer || '|' || (gallery_id = '${gal}') from opportunities where id = '${pending}'`), 'Casa do Mar|true');
    as(P[1], `select admin_grant_plan('${C}', 'gallery', current_date + 60)`);
    const direct = as(C, `select suggest_opportunity(${args('Winter Residency')})`);
    assert.equal(as('anon', `select count(*) from opportunities where id = '${direct}'`), '1', 'the Gallery plan publishes directly');
    assert.equal(JSON.parse(as('anon', 'select opportunities_list()')).find((o) => o.id === direct).gallery_id, gal);
    assert.equal(JSON.parse(as('anon', `select gallery_page('${gal}')`)).opportunities[0].title, 'Winter Residency');
    assert.match(as(P[1], `select string_agg(action, ',') from admin_audit_log()`), /opportunity\.published_by_gallery/);
    as(C, `select apply_gallery('Casa do Mar', 'Porto', 'PT', 'https://casadomar.example', 'New text.')`);
    assert.equal(JSON.parse(as('anon', `select gallery_page('${gal}')`)).bio, 'New text.', 'edits keep verification');
    as(C, `select apply_gallery('Casa Nova', 'Porto', 'PT', 'https://casadomar.example', 'New text.')`);
    assert.equal(as('anon', `select gallery_page('${gal}') is null`), 't', 'a new name goes back for review');
    as(P[1], `select review_gallery('${gal}', true)`);
  });

  await t.test('invites: optional by default; when required, new accounts need a valid code; codes are limited and revocable', () => {
    const newUser = (n, invite) => psql(`insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000009${n}', 'beta${n}@example.com', ${invite ? `'{"invite": "${invite}"}'` : 'null'})`);
    newUser('01');
    fails(B, 'select admin_create_invite(2)', /Admins only|permission denied/);
    const code = as(P[1], `select admin_create_invite(2, 30, 'Wave 1')`);
    assert.match(code, /^[A-HJKMNP-Z2-9]{10}$/);
    assert.equal(as('anon', `select check_invite('${code.toLowerCase()}')`), 't');
    assert.equal(as('anon', `select check_invite('NOPE')`), 'f');
    noRowsFor('anon', 'select count(*) from invite_codes');
    noRowsFor(B, 'select count(*) from invite_codes');
    as(P[1], 'select admin_set_invite_required(true)');
    assert.equal(JSON.parse(as('anon', 'select app_flags()')).invite_required, true);
    assert.throws(() => newUser('02'), /invite-only/);
    assert.throws(() => newUser('03', 'WRONGCODE1'), /invite-only/);
    newUser('04', code.toLowerCase());
    assert.equal(psql(`select count(*) from profiles where id = '00000000-0000-0000-0000-000000000904'`), '1', 'invitees get a profile');
    newUser('05', code);
    assert.throws(() => newUser('06', code), /invite-only/, 'two uses only');
    const fresh = as(P[1], 'select admin_create_invite(5)');
    as(P[1], `select admin_revoke_invite('${fresh}')`);
    assert.throws(() => newUser('07', fresh), /invite-only/, 'revoked');
    assert.equal(JSON.parse(as(P[1], 'select admin_invites()')).codes.find((c) => c.code === code).uses, 2);
    as(P[1], 'select admin_set_invite_required(false)');
    newUser('08');
    assert.match(as(P[1], `select string_agg(action, ',') from admin_audit_log()`), /beta\.invites_required/);
  });

  await t.test('feedback and app errors: members send feedback, moderators resolve it; errors are logged without personal data and capped', () => {
    fails('anon', `select submit_feedback('bug', 'Something broke')`, /Sign in|permission denied/);
    fails(B, `select submit_feedback('bug', 'no')`, /check constraint/);
    const f = as(B, `select submit_feedback('idea', 'Let me sort my collections by date.', '#collections', 'Test browser')`);
    assert.equal(as(B, 'select count(*) from feedback'), '1');
    noRowsFor(C, `select count(*) from feedback where id = '${f}'`);
    fails(B, 'select admin_feedback()', /Admins only|permission denied/);
    assert.equal(JSON.parse(as(P[1], 'select admin_feedback()'))[0].message, 'Let me sort my collections by date.');
    as(P[1], `select resolve_feedback('${f}', 'Planned')`);
    fails(P[1], `select resolve_feedback('${f}')`, /already resolved/);
    as('anon', `select log_client_error('TypeError: x is undefined', 'app.js:10:5', '#art/abc?token=secret', 'abc123', 'Test browser')`);
    as(B, `select log_client_error('TypeError: x is undefined', 'app.js:10:5', '#home', 'abc123', 'Test browser')`);
    noRowsFor('anon', 'select count(*) from client_errors');
    noRowsFor(B, 'select count(*) from client_errors');
    const errs = JSON.parse(as(P[1], 'select admin_client_errors(7)'));
    assert.equal(errs[0].count, 2);
    assert.equal(errs[0].pages.some((p) => p.includes('secret')), false, 'query strings are dropped');
    assert.equal(psql(`select count(*) from information_schema.columns where table_name = 'client_errors' and column_name in ('user_id', 'ip', 'email')`), '0');
    psql(`insert into client_errors (message, created_at) select 'flood', now() from generate_series(1, 500)`);
    as('anon', `select log_client_error('one too many')`);
    assert.equal(psql(`select count(*) from client_errors where message = 'one too many'`), '0', 'capped at 500 an hour');
    psql(`update client_errors set created_at = now() - interval '31 days' where message = 'flood'`);
    fails(B, 'select prune_client_errors()', /permission denied/);
    assert.equal(psql('select prune_client_errors()'), '500');
  });

  await t.test('billing: inactive while payments are off; only the service role applies events, each once; paid plans can’t be overwritten by grants', () => {
    const ev = (id, status, plan = 'pro') => `select apply_billing_event('${id}', 'customer.subscription.updated', '${B}', '${plan}', '${status}', now() + interval '30 days', 'cus_1', 'sub_1')`;
    fails('service_role', ev('evt_1', 'active'), /switched off/);
    fails(B, ev('evt_1', 'active'), /permission denied/);
    fails('anon', ev('evt_1', 'active'), /permission denied/);
    psql('update app_settings set payments_enabled = true');
    assert.equal(as('service_role', ev('evt_1', 'active')), 'applied');
    assert.equal(as('service_role', ev('evt_1', 'active')), 'duplicate');
    const mine = JSON.parse(as(B, 'select my_plan()'));
    assert.equal(mine.plan.code, 'pro');
    assert.equal(mine.manage, true);
    fails(P[1], `select admin_grant_plan('${B}', 'elite', current_date + 30)`, /paid subscription/);
    assert.equal(as('service_role', ev('evt_2', 'active', 'gallery')), 'not a verified gallery');
    assert.equal(as('service_role', ev('evt_3', 'canceled')), 'applied');
    assert.equal(JSON.parse(as(B, 'select my_plan()')).plan.code, 'free');
    psql('update app_settings set payments_enabled = false');
    assert.equal(JSON.parse(as('anon', 'select app_flags()')).payments_enabled, false);
  });

  await t.test('security: every table has row-level security, every privileged function pins its search path, and guests reach only public functions', () => {
    assert.equal(psql(`select coalesce(string_agg(c.relname, ','), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`), '', 'tables without RLS');
    assert.equal(psql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`), '', 'security definer functions without a search path');
    // Functions a guest (anon) may run. Trigger functions are excluded: they can't be called directly.
    const anonCan = psql(`select string_agg(distinct p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype and has_function_privilege('anon', p.oid, 'execute')`).split(',');
    const PUBLIC_FUNCTIONS = ['app_flags', 'arena', 'artist_achievements', 'artist_passport', 'chart_baseline', 'check_invite', 'community_snapshot',
      'competition_detail', 'drop_detail', 'drops_overview', 'gallery_page', 'log_client_error', 'member_leaderboards', 'opportunities_list',
      'plan_badges', 'public_collection', 'record_events', 'index_week', 'artist_index_badge', 'artists_accepting_payments', 'founding_artists_list', 'verified_artists', 'verify_certificate'];
    const unexpected = anonCan.filter((f) => !PUBLIC_FUNCTIONS.includes(f));
    assert.deepEqual(unexpected, [], 'privileged functions guests can run that aren’t on the public list');
    // Every moderator function checks is_admin() itself (the app hiding a button is not a permission).
    assert.equal(psql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and p.proname ~ '^(admin_|review_|resolve_|decide_|revoke_role$|create_competition$|cancel_competition$)'
        and p.prosrc !~ 'is_admin\\(\\)'`), '', 'moderator functions without an is_admin() check');
  });

  // ——— Phase 7 (0013): the Abremi Guide ———
  await t.test('guide: members only; the artist mode is for artists; context is public catalog data plus the member’s own, never hidden or unreleased works or private details', () => {
    fails('anon', `select begin_assistant_request('visitor')`, /permission denied|Sign in/);
    fails(B, `select begin_assistant_request('artist')`, /for artists/);
    fails(B, `select begin_assistant_request('hack')`, /Unknown mode/);
    const hidden = psql(`select coalesce(string_agg(id, ','), '') from artworks where hidden or release_at > now()`).split(',').filter(Boolean);
    assert.ok(hidden.length > 0, 'the fixture has hidden or unreleased works');
    const ctx = JSON.parse(as(B, `select begin_assistant_request('visitor', 'artwork', '${eArt}')`));
    assert.equal(ctx.page.artwork.id, eArt);
    assert.ok('likes' in ctx.page.signals);
    const ids = new Set(ctx.catalog.artworks.map((w) => w.id));
    assert.ok(ids.size > 100, 'the catalog is there');
    assert.deepEqual(hidden.filter((h) => ids.has(h)), [], 'no hidden or unreleased works');
    const text = JSON.stringify(ctx);
    assert.doesNotMatch(text, /@example\.com|owner_id|"email"/, 'no contact details or owner ids');
    assert.equal(ctx.collections, null, 'collections only in the collector mode');
    assert.equal(ctx.studio, null, 'studio data only in the artist mode');
    for (const h of hidden.slice(0, 3)) assert.equal(as(B, `select begin_assistant_request('visitor', 'artwork', '${h}') -> 'page'`), 'null', 'hidden pages give no context');
    // Collections: someone else's private one is invisible; a shared one shows no owner name.
    const secret = psql(`insert into collections (owner_id, name, is_private) values ('${C}', 'Secret picks', true) returning id`);
    const shared = psql(`insert into collections (owner_id, name, is_private) values ('${C}', 'Sea light', false) returning id`);
    psql(`insert into collection_items (collection_id, artwork_id) values ('${secret}', '${eArt}'), ('${shared}', '${eArt}')`);
    assert.equal(as(B, `select begin_assistant_request('visitor', 'collection', '${secret}') -> 'page'`), 'null');
    const sharedCtx = JSON.parse(as(B, `select begin_assistant_request('visitor', 'collection', '${shared}') -> 'page'`));
    assert.equal(sharedCtx.name, 'Sea light');
    assert.equal(JSON.stringify(sharedCtx).includes(psql(`select name from profiles where id = '${C}'`)), false, 'no owner name');
    const mine = JSON.parse(as(C, `select begin_assistant_request('collector', 'collection', '${secret}')`));
    assert.equal(mine.page.mine, true);
    assert.ok(mine.collections.some((c) => c.name === 'Secret picks' && c.private), 'your own collections, in the collector mode');
    const rank = JSON.parse(as(B, `select begin_assistant_request('visitor', 'ranking', 'artworks') -> 'page'`));
    assert.ok(Array.isArray(rank.top_artworks));
    const artist = JSON.parse(as(E, `select begin_assistant_request('artist', 'artist', 'm_${E}')`));
    assert.equal(artist.studio.artist.id, `m_${E}`);
    assert.ok('views' in artist.studio.last_30_days);
    assert.ok(artist.studio.works.length > 0);
  });

  await t.test('guide: personalization uses only the member’s own follows, likes, saves and stated interests, and can be switched off or reset', () => {
    psql(`insert into follows (user_id, artist_id, role) values ('${B}', '${seed.artists[3].id}', 'fan') on conflict do nothing`);
    let ctx = JSON.parse(as(B, `select begin_assistant_request('visitor')`));
    assert.ok(ctx.personal.follows.includes(seed.artists[3].id));
    as(B, `select set_assistant_preferences(true, 'Street art from Lisbon')`);
    assert.equal(JSON.parse(as(B, 'select assistant_preferences()')).interests, 'Street art from Lisbon');
    as(B, `select set_assistant_preferences(false, 'Street art from Lisbon')`);
    ctx = JSON.parse(as(B, `select begin_assistant_request('visitor')`));
    assert.deepEqual([ctx.personal.follows, ctx.personal.saved, ctx.personal.interests], [[], [], ''], 'switched off: nothing personal');
    as(B, `select record_assistant_event('artwork_click', '${eArt}')`);
    as(B, 'select reset_assistant_personalization()');
    const prefs = JSON.parse(as(B, 'select assistant_preferences()'));
    assert.deepEqual(prefs, { personalize: true, interests: '' });
    assert.equal(psql(`select count(*) from assistant_events where user_id = '${B}'`), '0', 'reset forgets what you did with suggestions');
    noRowsFor(C, `with u as (update profiles set assistant_interests = 'x' where id = '${B}' returning 1) select count(*) from u`);
  });

  await t.test('guide: a daily allowance by plan (failed replies don’t count), no direct writes, and requests stay private', () => {
    const usage = () => JSON.parse(as(B, 'select assistant_usage()'));
    assert.equal(usage().limit, 30);
    const r = JSON.parse(as(B, `select begin_assistant_request('visitor')`)).request_id;
    const before = usage().used;
    as(B, `select finish_assistant_request('${r}', false)`);
    assert.equal(usage().used, before - 1, 'failed replies don’t count');
    psql(`insert into assistant_requests (user_id, mode, status) select '${B}', 'visitor', 'done' from generate_series(1, ${30 - usage().used})`);
    fails(B, `select begin_assistant_request('visitor')`, /today’s 30 messages/);
    as(P[1], `select admin_grant_plan('${B}', 'pro', current_date + 7)`);
    assert.equal(usage().limit, 60);
    as(B, `select begin_assistant_request('collector')`);
    as(P[1], `select admin_revoke_plan('${B}')`);
    noRowsFor(B, `with u as (insert into assistant_requests (user_id, mode) values ('${B}', 'visitor') returning 1) select count(*) from u`);
    noRowsFor(B, `with u as (delete from assistant_requests returning 1) select count(*) from u`);
    noRowsFor(C, `select count(*) from assistant_requests where user_id = '${B}'`);
    const cReq = psql(`select id from assistant_requests where user_id = '${C}' and status = 'pending' limit 1`);
    as(B, `select finish_assistant_request('${cReq}', true)`);
    assert.equal(psql(`select status from assistant_requests where id = '${cReq}'`), 'pending', 'only your own requests');
  });

  await t.test('guide: what people do with suggestions is counted, readable only by moderators; repeat use is measured; choosing suggestions never reads plans', () => {
    as(B, `select record_assistant_event('artwork_click', '${eArt}')`);
    as(B, `select record_assistant_event('follow', 'm_${E}')`);
    fails(B, `select record_assistant_event('bogus')`, /check constraint/);
    fails('anon', `select record_assistant_event('open')`, /permission denied/);
    noRowsFor(B, 'select count(*) from assistant_events');
    psql(`update assistant_requests set created_at = now() - interval '2 days' where id = (select id from assistant_requests where user_id = '${B}' order by created_at limit 1)`);
    fails(B, 'select admin_assistant_metrics(30)', /Admins only|permission denied/);
    const m = JSON.parse(as(P[1], 'select admin_assistant_metrics(30)'));
    assert.ok(m.events.artwork_click >= 1 && m.events.follow >= 1);
    assert.ok(m.members >= 2 && m.returning >= 1, 'returning members are counted');
    assert.ok(m.by_mode.visitor >= 1);
    assert.equal(psql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('assistant_catalog', 'assistant_page_context') and p.prosrc ~* '(subscriptions|current_plan|plans\\b|plan_badges)'`), '', 'suggestions are chosen without plans');
    fails(B, 'select assistant_catalog()', /permission denied/);
  });

  // ——— 0014: drop teasers and plan badges ———
  await t.test('drop teasers: before release only a colour palette is public, never the image; the artist still sees it', () => {
    const drop = psql(`select id from drops where owner_id = '${E}' and released_at is null and cancelled_at is null and release_at > now() limit 1`);
    assert.ok(drop, 'the fixture has an upcoming drop');
    const palette = '#112233,#445566,#778899,#aabbcc,#ddeeff,#102030,#405060,#708090,#a0b0c0';
    psql(`update drops set teaser_palette = '${palette}' where id = '${drop}'`);
    for (const who of ['anon', B]) {
      const o = JSON.parse(as(who, 'select drops_overview()')).find((d) => d.id === drop);
      assert.equal(o.teaser_thumb, null, 'no teaser image before release');
      assert.equal(o.teaser_palette, palette);
      assert.equal(JSON.parse(as(who, `select drop_detail('${drop}')`)).teaser_thumb, null);
    }
    assert.ok(JSON.parse(as(E, `select drop_detail('${drop}')`)).teaser_thumb, 'the artist sees their own teaser');
    assert.throws(() => psql(`update drops set teaser_palette = 'url(javascript:alert(1))' where id = '${drop}'`), /check constraint/);
    const released = psql(`select id from drops where released_at is not null limit 1`);
    if (released) assert.ok(JSON.parse(as('anon', `select drop_detail('${released}')`)).teaser_thumb, 'shown once released');
  });

  await t.test('plan badges: shown by default, and artists can hide theirs', () => {
    as(P[1], `select admin_grant_plan('${E}', 'pro', current_date + 30)`);
    assert.equal(JSON.parse(as('anon', 'select plan_badges()'))[`m_${E}`], 'Pro');
    as(E, 'select set_plan_badge(false)');
    assert.equal(JSON.parse(as('anon', 'select plan_badges()'))[`m_${E}`], undefined);
    assert.equal(JSON.parse(as(E, 'select my_plan()')).show_badge, false);
    fails('anon', 'select set_plan_badge(false)', /permission denied|Sign in/);
    as(E, 'select set_plan_badge(true)');
    assert.equal(JSON.parse(as('anon', 'select plan_badges()'))[`m_${E}`], 'Pro');
    as(P[1], `select admin_revoke_plan('${E}')`);
  });

  // ——— Phase 8 (0015): offers, waitlists, alerts, collector interests ———
  const freeWork = (who) => psql(`select id from artworks where owner_id = '${E}' and not hidden and (release_at is null or release_at <= now())
      and id not in (select artwork_id from inquiries where sender_id = '${who}' and status = 'open' and artwork_id is not null) order by id limit 1`);
  await t.test('offers: an amount on a purchase inquiry, with every inquiry rule; only the two people see it', () => {
    const w = freeWork(C);
    psql(`update artworks set availability = 'available', price = 500 where id = '${w}'`);
    fails(C, `select send_offer('${w}', 0, 'EUR', 'I would love to buy this piece.')`, /between 1 and/);
    fails(C, `select send_offer('${w}', 450, 'dollars', 'I would love to buy this piece.')`, /three-letter currency/);
    fails(C, `select send_offer('${seed.artworks[0].id}', 450, 'EUR', 'I would love to buy this piece.')`, /Sample artists/);
    fails('anon', `select send_offer('${w}', 450, 'EUR', 'I would love to buy this piece.')`, /permission denied|Sign in/);
    const q = as(C, `select send_offer('${w}', 450, 'eur', 'I would love to buy this piece.')`);
    assert.deepEqual(JSON.parse(as(E, `select inquiry_offer('${q}')`)), { amount: 450, currency: 'EUR' });
    assert.deepEqual(JSON.parse(as(C, `select inquiry_offer('${q}')`)), { amount: 450, currency: 'EUR' });
    assert.equal(as(B, `select inquiry_offer('${q}')`), '', 'no one else');
    assert.match(as(E, `select title from notifications where link = 'inquiry/${q}'`), /made an offer of EUR 450\.00 for “/);
    noRowsFor(C, `with u as (update inquiries set offer_amount = 1 where id = '${q}' returning 1) select count(*) from u`);
    psql(`update artworks set availability = 'sold' where id = '${w}'`);
    const w2 = freeWork(B);
    psql(`update artworks set availability = 'sold' where id = '${w2}'`);
    fails(B, `select send_offer('${w2}', 300, 'USD', 'Is this still possible to buy?')`, /isn’t available/);
  });

  await t.test('waitlists and alerts: treasurers and the waitlist are told when a work becomes available or changes price; never the artist', () => {
    const w = freeWork(B);
    psql(`update artworks set availability = 'sold' where id = '${w}'`);
    as(B, `select watch_artwork('${w}', true)`);
    as(C, `insert into reactions (artwork_id, kind) values ('${w}', 'super') on conflict do nothing`);
    fails(B, `select watch_artwork('${seed.artworks[0].id}', true)`, /can’t follow this work/);
    assert.ok(JSON.parse(as(B, 'select my_watches()')).includes(w));
    noRowsFor(C, `select count(*) from artwork_watches where user_id = '${B}'`);
    const alerts = (who) => Number(as(who, `select count(*) from notifications where kind = 'artwork_alert' and link = 'art/${w}'`));
    psql(`update artworks set availability = 'available' where id = '${w}'`);
    assert.equal(alerts(B), 1, 'the waitlist');
    assert.equal(alerts(C), 1, 'treasurers');
    assert.equal(alerts(E), 0, 'never the artist');
    assert.match(as(B, `select title from notifications where kind = 'artwork_alert' order by created_at desc limit 1`), /is now available/);
    psql(`update artworks set price = coalesce(price, 100) + 50 where id = '${w}'`);
    assert.equal(alerts(B), 2);
    assert.match(as(C, `select title from notifications where kind = 'artwork_alert' order by created_at desc limit 1`), /has a new price/);
    as(B, `select watch_artwork('${w}', false)`);
    assert.equal(JSON.parse(as(B, 'select my_watches()')).includes(w), false);
  });

  await t.test('drop alerts: members who treasured an artist’s work hear about their drops (followers are told once, as before)', () => {
    const w = freeWork(A);
    as(B, `insert into reactions (artwork_id, kind) values ('${w}', 'super') on conflict do nothing`);
    psql(`delete from follows where user_id = '${B}' and artist_id = 'm_${E}'`);
    as(P[1], `select admin_grant_plan('${E}', 'elite', current_date + 30)`);
    put(E, `${E}/p8.webp`); put(E, `${E}/p8-thumb.webp`);
    const [lot] = publish(E, { image: `${E}/p8.webp`, thumb: `${E}/p8-thumb.webp`, title: 'Lot P8' }).split('|');
    const drop = as(E, `select create_drop('Night Harbour', '', now() + interval '3 hours', array['${lot}'])`);
    assert.match(as(B, `select title from notifications where link = 'drop/${drop}'`), /whose work you treasured, announced a drop: “Night Harbour”/);
    const followers = psql(`select count(*) from notifications n join follows f on f.user_id = n.user_id and f.artist_id = 'm_${E}' where n.link = 'drop/${drop}' group by n.user_id having count(*) > 1`);
    assert.equal(followers, '', 'no follower is told twice');
    as(E, `select cancel_drop('${drop}')`);
    as(P[1], `select admin_revoke_plan('${E}')`);
  });

  await t.test('collector interests: private to the member, validated, and switched off with personalization', () => {
    fails('anon', `select set_discovery_interests(array['oil'], array['PT'], 2000)`, /permission denied|Sign in/);
    fails(B, `select set_discovery_interests(array['oil'], array['PT'], 0)`, /price limit/);
    as(B, `select set_discovery_interests(array['oil', 'photography', 'Oil!'], array['PT', 'us', 'US'], 2000)`);
    const mine = JSON.parse(as(B, 'select my_discovery_interests()'));
    assert.deepEqual(mine.interests.mediums, ['oil', 'photography'], 'only valid mediums');
    assert.deepEqual(mine.interests.regions, ['PT', 'US']);
    assert.equal(mine.interests.price_max, 2000);
    assert.equal(mine.personalize, true);
    noRowsFor(C, `select count(*) from profiles where id = '${B}' and discovery_interests ? 'mediums'`);
  });

  // ——— 0016: the Abremi Index ———
  await t.test('the Abremi Index: a frozen weekly chart of real member work, overall and by medium and country; badges; never plans', () => {
    const week = psql(`select (date_trunc('week', now()) + interval '7 days')::date`); // covers this week's activity
    fails('anon', `select compute_index('${week}')`, /permission denied/);
    fails(B, `select compute_index('${week}')`, /permission denied/);
    assert.ok(Number(psql(`select compute_index('${week}')`)) > 0);
    const chart = JSON.parse(as('anon', `select index_week('${week}', 'overall')`));
    assert.ok(chart.artworks.length > 0 && chart.artists.length > 0);
    assert.ok(chart.artworks.every((w) => w.id !== seed.artworks[0].id && !/^w\d+$/.test(w.id)), 'no sample works');
    assert.ok(chart.artists.every((a) => a.id.startsWith('m_')), 'member artists only');
    assert.deepEqual(chart.artworks.map((w) => w.rank), chart.artworks.map((_, i) => i + 1));
    assert.ok(chart.artworks.every((w, i) => i === 0 || w.score <= chart.artworks[i - 1].score), 'ordered by score');
    assert.ok(chart.charts.some((c) => c.startsWith('medium:')) && chart.charts.some((c) => c.startsWith('country:')));
    const top = chart.artists[0];
    const badge = JSON.parse(as('anon', `select artist_index_badge('${top.id}')`));
    assert.equal(badge.rank, 1);
    assert.equal(badge.chart, 'overall');
    assert.equal(as('anon', `select artist_index_badge('${seed.artists[0].id}') is null`), 't', 'no badge for sample artists');
    const again = psql(`select md5(index_week('${week}', 'overall')::text)`);
    psql(`select compute_index('${week}')`);
    assert.equal(psql(`select md5(index_week('${week}', 'overall')::text)`), again, 'recomputing gives the same chart');
    noRowsFor(B, `with u as (insert into index_weeks (week) values (current_date + 30) returning 1) select count(*) from u`);
    fails(B, 'select admin_publish_index()', /Admins only|permission denied/);
    assert.ok(Number(as(P[1], 'select admin_publish_index()')) >= 0);
    assert.equal(psql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('compute_index', 'index_week', 'artist_index_badge') and p.prosrc ~* '(subscriptions|current_plan|plans\\b|plan_badges)'`), '', 'the Index never reads plans');
  });

  // ——— 0017: checkout, orders, editions ———
  await t.test('checkout: off by default; only payable artists; one buyer at a time; only the signed webhook marks it paid, once, for the right amount', () => {
    const w = psql(`select id from artworks where owner_id = '${E}' and not hidden and (release_at is null or release_at <= now()) and drop_id is null order by id desc limit 1`);
    psql(`update artworks set availability = 'available', price = 400, edition_size = null where id = '${w}'`);
    fails(C, `select begin_purchase('${w}')`, /isn’t switched on/);
    psql('update app_settings set sales_enabled = true');
    fails(C, `select begin_purchase('${w}')`, /can’t take payments yet/);
    fails(E, `select set_payout_account('${E}', 'acct_test1', true, true, true)`, /permission denied/);
    as('service_role', `select set_payout_account('${E}', 'acct_test1', true, true, true)`);
    assert.ok(JSON.parse(as('anon', 'select artists_accepting_payments()')).includes(`m_${E}`));
    assert.equal(JSON.parse(as(E, 'select my_payout_status()')).charges_enabled, true);
    fails(E, `select begin_purchase('${w}')`, /your own work/);
    fails(C, `select begin_purchase('${seed.artworks[0].id}')`, /not found/);
    const order = JSON.parse(as(C, `select begin_purchase('${w}')`));
    assert.deepEqual([order.amount_cents, order.fee_cents], [40000, 8000], '20% commission');
    fails(B, `select begin_purchase('${w}')`, /already buying/);
    fails(C, `select order_payout_target('${order.order_id}')`, /permission denied/);
    assert.equal(as('service_role', `select order_payout_target('${order.order_id}')`), 'acct_test1');
    as('service_role', `select attach_checkout_session('${order.order_id}', 'cs_test_1')`);
    fails(C, `select complete_order('cs_test_1', 'pi_1', 40000, null)`, /permission denied/);
    fails('service_role', `select complete_order('cs_test_1', 'pi_1', 39999, null)`, /Amount mismatch/);
    assert.equal(as('service_role', `select complete_order('cs_test_1', 'pi_1', 40000, '{"name": "Cy Park", "address": {"city": "Seoul"}}')`), 'paid');
    assert.equal(as('service_role', `select complete_order('cs_test_1', 'pi_1', 40000, null)`), 'already paid');
    assert.equal(psql(`select availability from artworks where id = '${w}'`), 'sold');
    assert.match(as(E, `select title from notifications where kind = 'sale' order by created_at desc limit 1`), /You sold/);
    const sales = JSON.parse(as(E, 'select my_orders()')).sales;
    assert.equal(sales[0].shipping.name, 'Cy Park', 'the artist sees where to ship');
    assert.equal(JSON.parse(as(C, 'select my_orders()')).purchases[0].status, 'paid');
    noRowsFor(B, `select count(*) from orders where id = '${order.order_id}'`);
    noRowsFor(C, `with u as (update orders set status = 'delivered' where id = '${order.order_id}' returning 1) select count(*) from u`);
    assert.equal(JSON.parse(as('anon', `select artist_passport('m_${E}')`)).verified_sales, 1, 'verified on the Passport');

    // Fulfilment and disputes
    fails(C, `select mark_shipped('${order.order_id}', 'UPS', '1Z999')`, /can’t be marked shipped/);
    fails(E, `select mark_shipped('${order.order_id}', 'UPS', '')`, /tracking number/);
    as(E, `select mark_shipped('${order.order_id}', 'UPS', '1Z999AA1')`);
    fails(E, `select confirm_delivery('${order.order_id}')`, /can’t be marked delivered/);
    as(C, `select confirm_delivery('${order.order_id}')`);
    fails(C, `select open_dispute('${order.order_id}', 'bad')`, /at least 10/);
    as(C, `select open_dispute('${order.order_id}', 'The canvas arrived torn at the corner.')`);
    fails(B, 'select admin_disputes()', /Admins only|permission denied/);
    assert.equal(JSON.parse(as(P[1], 'select admin_disputes()'))[0].reason, 'The canvas arrived torn at the corner.');
    as(P[1], `select resolve_dispute('${order.order_id}', true, 'Refund approved')`);
    assert.equal(as('service_role', `select refund_order('pi_1')`), 'refunded');
    assert.equal(JSON.parse(as(C, 'select my_orders()')).purchases[0].status, 'refunded');
    assert.match(as(P[1], `select string_agg(action, ',') from admin_audit_log()`), /order\.refund_approved/);
  });

  await t.test('editions: artist-made prints, one numbered print per order, sold out at the edition size', () => {
    const w = psql(`select id from artworks where owner_id = '${E}' and not hidden and (release_at is null or release_at <= now()) and drop_id is null and availability <> 'sold' order by id limit 1`);
    psql(`update artworks set availability = 'available', price = 50 where id = '${w}'`);
    fails(C, `select set_edition('${w}', 5)`, /Not your artwork/);
    fails(E, `select set_edition('${w}', 1)`, /2 to 500/);
    as(E, `select set_edition('${w}', 2)`);
    const buy = (who, n) => {
      const o = JSON.parse(as(who, `select begin_purchase('${w}')`));
      as('service_role', `select attach_checkout_session('${o.order_id}', 'cs_ed_${n}')`);
      assert.equal(as('service_role', `select complete_order('cs_ed_${n}', 'pi_ed_${n}', 5000, null)`), 'paid');
      return o;
    };
    buy(C, 1);
    assert.equal(psql(`select editions_sold || '|' || availability from artworks where id = '${w}'`), '1|available', 'still for sale');
    buy(B, 2);
    assert.equal(psql(`select editions_sold || '|' || availability from artworks where id = '${w}'`), '2|sold', 'sold out');
    assert.equal(psql(`select string_agg(edition_number::text, ',' order by edition_number) from orders where artwork_id = '${w}'`), '1,2');
    fails(E, `select set_edition('${w}', null)`, /have been sold/);
    psql('update app_settings set sales_enabled = false');
  });

  // ——— 0018: seasons, medium leagues, Art Battle streaks ———
  const seasonReference = (me, opts) => {
    const profiles = JSON.parse(psql(`select json_agg(json_build_object('id', id, 'name', name, 'country', country, 'role', role, 'public', public_leaderboards)) from profiles`));
    const reactions = JSON.parse(psql(`select coalesce(json_agg(json_build_object('user', r.user_id, 'artwork', r.artwork_id, 'kind', r.kind, 'role', r.role, 'medium', a.category,
      'at', (extract(epoch from r.created_at) * 1000000)::bigint, 'time', (extract(epoch from r.created_at) * 1000)::float8)), '[]')
      from reactions r join artworks a on a.id = r.artwork_id where not r.excluded and (a.owner_id is null or a.owner_id <> r.user_id)`));
    const reviews = JSON.parse(psql(`select coalesce(json_agg(json_build_object('user', v.user_id, 'rating', v.rating, 'medium', a.category, 'time', (extract(epoch from v.created_at) * 1000)::float8)), '[]')
      from reviews v join artworks a on a.id = v.artwork_id where a.owner_id is null or a.owner_id <> v.user_id`));
    return memberBoards({ profiles, reactions, reviews }, { me, ...opts });
  };
  const monthStart = (offset) => psql(`select (date_trunc('month', now() at time zone 'utc') + interval '${offset} month')::date`);
  const windowOf = (day) => seasonWindow(`${day}T00:00:00Z`);

  await t.test('seasons and medium leagues: the same boards counted within a month or a medium, identical to the JavaScript reference', () => {
    const last = monthStart(-1), now = monthStart(0);
    psql(`update reactions set created_at = '${last}'::date + interval '3 days' + (random() * interval '1 hour') where user_id in ('${L[2]}', '${L[3]}')`);
    for (const who of ['anon', L[3]]) {
      const me = who === 'anon' ? null : who;
      assert.deepEqual(boards(who, `p_season => '${now}'`), seasonReference(me, { season: windowOf(now) }));
      assert.deepEqual(boards(who, `p_season => '${last}'`), seasonReference(me, { season: windowOf(last) }));
      assert.deepEqual(boards(who, `p_medium => 'oil'`), seasonReference(me, { medium: 'oil' }));
      assert.deepEqual(boards(who, `p_season => '${last}', p_medium => 'oil'`), seasonReference(me, { season: windowOf(last), medium: 'oil' }));
    }
    const name = (id) => psql(`select name from profiles where id = '${id}'`);
    assert.ok(boards('anon', `p_season => '${last}'`).discoverers.some((r) => r.name === name(L[3])), 'last month’s discoverer is on last month’s board');
    assert.ok(!boards('anon', `p_season => '${now}'`).discoverers.some((r) => r.name === name(L[3])), 'and not on this month’s');
    assert.ok(!boards('anon', `p_season => '${last}'`).discoverers.some((r) => r.name === name(L[2])), 'opted-out members stay hidden');
    assert.ok(boards(L[2], `p_season => '${last}'`).me.discoverers.rank >= 1, 'but see their own standing');
    assert.deepEqual(boards('anon', `p_season => '${monthStart(-6)}'`).discoverers, [], 'a quiet season is empty');
    assert.ok(boards('anon', `p_medium => 'sculpture'`).discoverers.length <= boards('anon').discoverers.length);
  });

  await t.test('closing a season freezes its top 10 once, as permanent achievements; finished seasons only; public members only', () => {
    const last = monthStart(-1);
    fails('anon', `select close_season('${last}')`, /permission denied/);
    fails(L[3], `select close_season('${last}')`, /permission denied/);
    assert.throws(() => psql(`select close_season('${monthStart(0)}')`), (e) => /hasn’t finished/.test(String(e.stderr)));
    assert.ok(Number(psql(`select close_season('${last}')`)) > 0);
    assert.equal(psql(`select close_season('${last}')`), '0', 'only once');
    const label = psql(`select to_char('${last}'::date, 'FMMonth YYYY')`);
    const mine = JSON.parse(as(L[3], `select json_agg(label) from my_achievements()`));
    assert.ok(mine.includes(`Top 10 Discoverer · ${label}`), mine.join());
    assert.equal(psql(`select count(*) from season_results where user_id = '${L[2]}'`), '0', 'opted-out members aren’t awarded');
    assert.equal(as(L[3], 'select count(*) > 0 from season_results'), 't');
    noRowsFor(L[4], `select count(*) from season_results where user_id = '${L[3]}'`);
    noRowsFor(L[3], `with u as (insert into season_results (season, board, user_id, rank, score) values ('2020-01-01', 'critics', '${L[3]}', 1, 1) returning 1) select count(*) from u`);
    assert.match(as(L[3], `select title from notifications where kind = 'season' limit 1`), /You finished No\. \d+ among Top Discoverers/);
    assert.equal(psql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('season_boards', 'member_leaderboards', 'close_season', 'battle_streak') and p.prosrc ~* '(subscriptions|current_plan|plans\\b|plan_badges)'`), '', 'seasons never read plans');
  });

  await t.test('Art Battle streaks: a vote a day, one missed day a week forgiven, milestones at 7, 30 and 100 days', () => {
    const [x, y] = seed.artworks.slice(0, 2).map((w) => w.id);
    const vote = (who, daysAgo) => psql(`insert into battle_votes (user_id, winner_id, loser_id, role, gain, loss, created_at)
      values ('${who}', '${x}', '${y}', 'fan', 1, 1, date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '${daysAgo} days' + interval '12 hours')`);
    const streak = (who) => JSON.parse(as(who, 'select my_battle_streak()'));
    const reference = (who) => battleStreak(JSON.parse(psql(`select coalesce(json_agg(created_at), '[]') from battle_votes where user_id = '${who}'`)), Date.parse(psql(`select to_json(now())#>>'{}'`)));
    fails('anon', 'select my_battle_streak()', /Sign in first|permission denied/);
    fails(L[4], `select battle_streak('${L[5]}')`, /permission denied/);
    assert.deepEqual(streak(L[4]), { current: 0, best: 0, today: false, grace_used: false });
    for (const d of [10, 9, 8, 7, 6, 4, 3, 2, 1]) vote(L[4], d); // missed 5 days ago: forgiven
    assert.deepEqual(streak(L[4]), { current: 9, best: 9, today: false, grace_used: true });
    assert.deepEqual(streak(L[4]), reference(L[4]));
    assert.match(as(L[4], `select string_agg(code, ',') from my_achievements()`), /streak_7/);
    assert.doesNotMatch(as(L[4], `select string_agg(code, ',') from my_achievements()`), /streak_30/);
    for (const d of [20, 19, 18, 16, 15, 13]) vote(L[5], d); // two misses within a week: ends at the second
    vote(L[5], 0);
    const s = streak(L[5]);
    assert.deepEqual(s, reference(L[5]));
    assert.deepEqual([s.current, s.best, s.today], [1, 5, true]);
    assert.doesNotMatch(as(L[5], `select coalesce(string_agg(code, ','), '') from my_achievements()`), /streak_/);
  });

  // ——— 0019: founding artists ———
  await t.test('founding artists: moderators choose member artists; everyone can see them; rankings never read the list', () => {
    const list = (who = 'anon') => JSON.parse(as(who, 'select founding_artists_list()')).map((f) => f.artist_id);
    assert.deepEqual(list(), []);
    fails(B, `select admin_set_founding('m_${E}', true)`, /Admins only/);
    fails('anon', `select admin_set_founding('m_${E}', true)`, /permission denied/);
    fails(P[1], `select admin_set_founding('${seed.artists[0].id}', true)`, /member artists/);
    const before = psql(`select md5(coalesce((select json_agg(x order by x.artist_id)::text from artist_scores() x), '')) || md5(member_leaderboards()::text)`);
    assert.equal(as(P[1], `select admin_set_founding('m_${E}', true)`), 't');
    as(P[1], `select admin_set_founding('m_${E}', true)`);
    assert.deepEqual(list(), [`m_${E}`]);
    assert.deepEqual(list(B), [`m_${E}`]);
    assert.equal(psql(`select md5(coalesce((select json_agg(x order by x.artist_id)::text from artist_scores() x), '')) || md5(member_leaderboards()::text)`), before, 'featuring changes no score');
    noRowsFor(E, `with u as (insert into founding_artists (artist_id) values ('m_${B}') returning 1) select count(*) from u`);
    noRowsFor(E, `with u as (delete from founding_artists returning 1) select count(*) from u`);
    assert.match(as(P[1], `select string_agg(action, ',') from admin_audit_log()`), /artist\.founding_added/);
    assert.equal(psql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname not in ('founding_artists_list', 'admin_set_founding') and p.prosrc ~* 'founding_artists'`), '', 'nothing else reads the founding list');
    as(P[1], `select admin_set_founding('m_${E}', false)`);
    assert.deepEqual(list(), []);
    as(P[1], `select admin_set_founding('m_${E}', true)`);
  });

  // ——— 0020: verified artists and certificates of authenticity ———
  await t.test('verified artists: moderators confirm identity (optionally family-managed); public; rankings never read it', () => {
    const list = () => JSON.parse(as('anon', 'select verified_artists()'));
    fails(B, `select admin_set_verified('m_${E}', true, false)`, /Admins only/);
    fails('anon', `select admin_set_verified('m_${E}', true, false)`, /permission denied/);
    fails(P[1], `select admin_set_verified('${seed.artists[0].id}', true, false)`, /member artists/);
    const before = psql(`select md5(coalesce((select json_agg(x order by x.artist_id)::text from artist_scores() x), '')) || md5(member_leaderboards()::text)`);
    as(P[1], `select admin_set_verified('m_${E}', true, true)`);
    assert.deepEqual(list().map((v) => [v.artist_id, v.managed]), [[`m_${E}`, true]]);
    as(P[1], `select admin_set_verified('m_${E}', true, false)`);
    assert.equal(list()[0].managed, false, 'can be updated');
    assert.equal(psql(`select md5(coalesce((select json_agg(x order by x.artist_id)::text from artist_scores() x), '')) || md5(member_leaderboards()::text)`), before, 'verification changes no score');
    noRowsFor(E, `with u as (insert into artist_verifications (artist_id) values ('m_${B}') returning 1) select count(*) from u`);
    assert.match(as(P[1], `select string_agg(action, ',') from admin_audit_log()`), /artist\.verified/);
    assert.equal(psql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname not in ('verified_artists', 'admin_set_verified', 'verify_certificate') and p.prosrc ~* 'artist_verifications'`), '', 'nothing else reads verifications');
  });

  await t.test('certificates: every paid sale gets a unique code; anyone can check it; never shows the buyer; void after a refund', () => {
    const codes = psql(`select string_agg(status || '=' || coalesce(certificate_code, '-'), ' ' order by created_at) from orders`).split(' ');
    assert.ok(codes.length >= 3);
    for (const c of codes) {
      const [status, code] = c.split('=');
      if (['paid', 'shipped', 'delivered', 'disputed', 'refunded'].includes(status)) assert.match(code, /^ABR-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/, c);
    }
    assert.equal(psql(`select count(distinct certificate_code) = count(certificate_code) from orders`), 't', 'unique');
    const paid = psql(`select certificate_code from orders where status in ('paid', 'shipped', 'delivered') and edition_number is not null order by created_at limit 1`);
    const cert = JSON.parse(as('anon', `select verify_certificate('${paid.toLowerCase()}')`));
    assert.equal(cert.code, paid);
    assert.equal(cert.valid, true);
    assert.equal(cert.status, 'valid');
    assert.equal(cert.verified, true, 'shows the verified artist');
    assert.ok(cert.edition_number >= 1 && cert.edition_size === 2);
    const text = as('anon', `select verify_certificate('${paid}')::text`);
    const buyerId = psql(`select buyer_id from orders where certificate_code = '${paid}'`);
    assert.ok(!text.includes(buyerId), 'never the buyer’s id');
    assert.ok(!text.includes(psql(`select name from profiles where id = '${buyerId}'`)), 'or name');
    assert.ok(!/buyer|shipping|example\.com/i.test(text), 'or anything about them');
    const refunded = psql(`select certificate_code from orders where status = 'refunded' limit 1`);
    const voided = JSON.parse(as('anon', `select verify_certificate('${refunded}')`));
    assert.deepEqual([voided.valid, voided.status], [false, 'void']);
    assert.equal(as('anon', `select verify_certificate('ABR-0000-0000-0000') is null`), 't');
    const buyer = buyerId;
    assert.ok(JSON.parse(as(buyer, 'select my_orders()')).purchases.some((o) => o.certificate === paid), 'the buyer has it');
    assert.ok(JSON.parse(as(E, 'select my_orders()')).sales.some((o) => o.certificate === paid), 'so does the artist');
    noRowsFor(buyer, `with u as (update orders set certificate_code = 'ABR-FAKE-FAKE-FAKE' returning 1) select count(*) from u`);
  });

  await t.test('0020 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0020_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.columns where table_name = 'orders' and column_name = 'certificate_code'`), '0');
    assert.ok(JSON.parse(as(E, 'select my_orders()')).sales.length > 0, 'my_orders still works');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from pg_proc where proname in ('verify_certificate', 'verified_artists', 'admin_set_verified')`), '3');
    assert.equal(psql(`select count(*) from orders where status in ('paid', 'shipped', 'delivered', 'disputed', 'refunded') and certificate_code is null`), '0', 'codes reissued for past sales');
  });

  await t.test('0019 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0019_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'founding_artists'`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from pg_proc where proname in ('founding_artists_list', 'admin_set_founding')`), '2');
  });

  await t.test('0018 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0018_down.sql'));
    assert.equal(psql(`select count(*) from pg_proc where proname in ('season_boards', 'close_season', 'battle_streak')`), '0');
    assert.ok(JSON.parse(as('anon', 'select member_leaderboards()::text')).discoverers);
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from pg_proc where proname in ('season_boards', 'close_season', 'battle_streak')`), '3');
  });

  await t.test('0017 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0017_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('orders', 'payout_accounts')`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('orders', 'payout_accounts')`), '2');
  });

  await t.test('0016 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0016_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('index_weeks', 'index_entries')`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('index_weeks', 'index_entries')`), '2');
  });

  await t.test('0015 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0015_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'artwork_watches'`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'artwork_watches'`), '1');
  });

  await t.test('0014 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0014_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.columns where (table_name, column_name) in (('drops', 'teaser_palette'), ('profiles', 'show_plan_badge'))`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.columns where (table_name, column_name) in (('drops', 'teaser_palette'), ('profiles', 'show_plan_badge'))`), '2');
  });

  await t.test('0013 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0013_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('assistant_requests', 'assistant_events')`), '0');
    assert.equal(psql(`select count(*) from information_schema.columns where table_name = 'profiles' and column_name like 'assistant_%'`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('assistant_requests', 'assistant_events')`), '2');
  });

  await t.test('0012 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0012_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('plans', 'subscriptions', 'galleries', 'invite_codes', 'feedback', 'client_errors', 'app_settings', 'billing_events')`), '0');
    assert.equal(JSON.parse(as(E, 'select coach_usage()')).limit, 20, 'undoing 0013 gives Free its earlier 20 Coach requests');
    psql(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000999', 'after-undo@example.com')`);
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('plans', 'subscriptions', 'galleries', 'invite_codes', 'feedback', 'client_errors', 'app_settings', 'billing_events')`), '8');
  });

  await t.test('0011 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0011_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('coach_requests', 'exhibitions', 'opportunities', 'saved_opportunities')`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('coach_requests', 'exhibitions', 'opportunities', 'saved_opportunities')`), '4');
  });

  await t.test('0010 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0010_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('inquiries', 'inquiry_messages', 'drops', 'drop_subscriptions')`), '0');
    assert.ok(JSON.parse(as('anon', 'select community_snapshot()')).uploads.length > 0);
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('inquiries', 'inquiry_messages', 'drops', 'drop_subscriptions')`), '4');
  });

  await t.test('0009 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0009_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('analytics_events', 'weekly_reports')`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('analytics_events', 'weekly_reports')`), '2');
  });

  await t.test('0008 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0008_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('competitions', 'competition_entries', 'competition_votes', 'notifications')`), '0');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('competitions', 'competition_entries', 'competition_votes', 'notifications')`), '4');
  });

  await t.test('0007 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0007_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('integrity_flags', 'member_achievements', 'achievement_definitions')`), '0');
    assert.ok(JSON.parse(as('anon', 'select community_snapshot()')).reactions.length > 0, 'the snapshot works after the undo');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('integrity_flags', 'member_achievements', 'achievement_definitions')`), '3');
  });

  await t.test('0006 can be undone, and setup.sql re-applies it', () => {
    psql(file('supabase/migrations/down/0006_down.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('collections', 'collection_items', 'audit_events')`), '0');
    assert.equal(psql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'artists' and column_name = 'bio'`), '0');
    psql(`update artworks set created_at = now() - interval '2 days' where owner_id = '${E}'`);
    put(E, `${E}/p3.webp`); put(E, `${E}/p3-thumb.webp`);
    assert.ok(publish(E, { image: `${E}/p3.webp`, thumb: `${E}/p3-thumb.webp`, title: 'After undo' }), 'publishing still works after the undo');
    psql(file('supabase/setup.sql'));
    assert.equal(psql(`select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('collections', 'collection_items', 'audit_events')`), '3');
  });
});
