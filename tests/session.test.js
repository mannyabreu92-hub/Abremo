// The sign-in can expire on the server while the device still thinks it's valid (a clock that is
// behind, a laptop that slept). The cloud client then refreshes it and retries once.
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeSupabase() {
  const state = { refreshed: 0, rpcCalls: 0, uploadCalls: 0, refreshFails: false };
  const expired = { data: null, error: { message: '"exp" claim timestamp check failed' } };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => {},
      refreshSession: async () => { state.refreshed += 1; return state.refreshFails ? { error: { message: 'refresh failed' } } : { error: null }; },
    },
    rpc: async (name) => { state.rpcCalls += 1; return state.refreshed ? { data: `${name} ok`, error: null } : expired; },
    storage: { from: () => ({ upload: async () => { state.uploadCalls += 1; return state.refreshed ? { data: { path: 'p' }, error: null } : expired; } }) },
    from: () => ({}),
  };
  globalThis.self = { supabase: { createClient: () => client } };
  return state;
}

test('an expired sign-in is refreshed and the request retried once (database calls and uploads)', async () => {
  const state = fakeSupabase();
  const { createSupabaseCloud } = await import(`../src/ui/cloud.js?${Date.now()}`);
  const cloud = await createSupabaseCloud('https://db.example.co', 'pk');
  assert.ok(cloud);
  const sb = globalThis.self.supabase.createClient();
  assert.deepEqual(await sb.rpc('artist_achievements'), { data: 'artist_achievements ok', error: null });
  assert.equal(state.refreshed, 1);
  assert.equal(state.rpcCalls, 2, 'retried exactly once');
  assert.deepEqual(await sb.storage.from('artworks').upload('a', 'b'), { data: { path: 'p' }, error: null });
  assert.equal(state.uploadCalls, 1, 'already refreshed: no retry needed');
});

test('if refreshing fails, the person is told to sign in again (never the technical message)', async () => {
  const state = fakeSupabase();
  state.refreshFails = true;
  const { createSupabaseCloud, check } = await import(`../src/ui/cloud.js?${Date.now() + 1}`);
  await createSupabaseCloud('https://db.example.co', 'pk');
  const sb = globalThis.self.supabase.createClient();
  const out = await sb.rpc('anything');
  assert.match(out.error.message, /Sign out and sign in again/);
  assert.throws(() => check({ data: null, error: { message: 'JWT expired' } }), /renewed\. Please try again/);
});
