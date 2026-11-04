// Database tests: run the Supabase migration on a real Postgres and check the security rules.
// Skipped unless GABANGI_PG holds psql connection flags, e.g.
//   GABANGI_PG="-h /tmp/gabangi-pg -p 54329 -U postgres" npm run test:db
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { battleResult, expectedScore } from '../src/core/elo.js';
import { buildSeedWorld } from '../src/core/seed.js';
import { seedSQL, setupSQL } from '../scripts/gen-seed-sql.js';

const flags = process.env.GABANGI_PG?.split(/\s+/).filter(Boolean);
const skip = !flags && 'set GABANGI_PG to run database tests';
let DB = `gabangi_test_${process.pid}`;
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
const seed = buildSeedWorld();
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
  DB = `gabangi_test_${process.pid}_${mode.startsWith('tables exposed') ? 'open' : 'strict'}`;
  psql(`drop database if exists ${DB}`, 'postgres');
  psql(`create database ${DB}`, 'postgres');
  t.after(() => psql(`drop database if exists ${DB}`, 'postgres'));
  psql(stub);
  psql(file('supabase/setup.sql')); // the exact file people paste into Supabase
  psql(file('supabase/setup.sql')); // and running it twice is safe
  psql(`insert into auth.users (id, email) values ('${A}', 'ana@example.com'), ('${B}', 'ben@example.com'), ('${C}', 'cy@example.com')`);

  await t.test('seed.sql and setup.sql are in sync with the app catalog and migration', () => {
    assert.equal(file('supabase/seed.sql'), seedSQL());
    assert.equal(file('supabase/setup.sql'), setupSQL());
    assert.equal(psql('select count(*) from artworks'), String(seed.artworks.length));
  });

  await t.test('signing up creates a fan profile named after the email', () => {
    assert.equal(as(A, 'select name || \'|\' || role from profiles'), 'ana|fan');
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
    assert.equal(as(B, 'select name from profiles'), 'ben');
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
    assert.equal(snap.members, 3);
    assert.ok(!JSON.stringify(snap).includes(A));
  });

  await t.test('ensure_profile heals a missing profile', () => {
    const D = '00000000-0000-0000-0000-00000000000d';
    psql(`alter table auth.users disable trigger on_auth_user_created; insert into auth.users (id, email) values ('${D}', 'dee@example.com'); alter table auth.users enable trigger on_auth_user_created;`);
    assert.equal(as(D, 'select count(*) from profiles'), '0');
    assert.equal(as(D, 'select role from ensure_profile()'), 'fan');
    fails('anon', 'select * from ensure_profile()', /permission denied|Sign in/);
  });
});
