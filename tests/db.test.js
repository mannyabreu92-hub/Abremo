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
import { sampleCatalog } from '../src/core/community.js';

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
    assert.equal(keys, 'follows,members,ratings,reactions,reviews', 'totals only: no uploads list, no member details');
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
