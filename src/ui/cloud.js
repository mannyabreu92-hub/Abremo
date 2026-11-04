// Community backend (Supabase). Every call the app makes to the server goes through this
// adapter, so the UI can be tested against a stand-in with the same methods.

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const toUser = (session) => (session?.user ? { id: session.user.id, email: session.user.email || '' } : null);

function check({ data, error }) {
  if (error) throw Object.assign(new Error(error.message || 'Request failed'), { cause: error });
  return data;
}

export async function createSupabaseCloud(url, key) {
  const { createClient } = await import(SUPABASE_JS);
  const sb = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  let user = null;

  return {
    kind: 'supabase',

    async init() {
      const { data } = await sb.auth.getSession();
      user = toUser(data.session);
      return user;
    },

    onAuth(cb) {
      sb.auth.onAuthStateChange((event, session) => {
        user = toUser(session);
        cb(user, event);
      });
    },

    async sendLink(email) {
      const emailRedirectTo = `${location.origin}${location.pathname}`;
      check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo, shouldCreateUser: true } }));
    },

    async verifyCode(email, token) {
      const data = check(await sb.auth.verifyOtp({ email, token, type: 'email' }));
      user = toUser(data.session);
      return user;
    },

    async signOut() {
      check(await sb.auth.signOut());
      user = null;
    },

    async snapshot() {
      return check(await sb.rpc('community_snapshot'));
    },

    async profile() {
      const row = check(await sb.rpc('ensure_profile'));
      return Array.isArray(row) ? row[0] : row;
    },

    async mine() {
      if (!user) return { reactions: [], follows: [], reviews: [] };
      const [reactions, follows, reviews] = await Promise.all([
        sb.from('reactions').select('artwork_id, kind, role'),
        sb.from('follows').select('artist_id, role'),
        sb.from('reviews').select('artwork_id, rating, body, created_at').eq('user_id', user.id),
      ]);
      return { reactions: check(reactions), follows: check(follows), reviews: check(reviews) };
    },

    async setReaction(artworkId, kind) {
      if (kind) check(await sb.from('reactions').upsert({ artwork_id: artworkId, kind }, { onConflict: 'user_id,artwork_id' }));
      else check(await sb.from('reactions').delete().eq('artwork_id', artworkId));
    },

    async setFollow(artistId, on) {
      if (on) check(await sb.from('follows').upsert({ artist_id: artistId }, { onConflict: 'user_id,artist_id', ignoreDuplicates: true }));
      else check(await sb.from('follows').delete().eq('artist_id', artistId));
    },

    async addReview(artworkId, rating, body) {
      check(await sb.from('reviews').insert({ artwork_id: artworkId, rating, body }));
    },

    async vote(winnerId, loserId) {
      const rows = check(await sb.rpc('cast_battle_vote', { p_winner: winnerId, p_loser: loserId }));
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async updateProfile(fields) {
      if (!user) throw new Error('Sign in first');
      return check(await sb.from('profiles').update(fields).eq('id', user.id).select().single());
    },

    async importGuest({ reactions, follows }) {
      if (reactions.length) check(await sb.from('reactions').upsert(reactions, { onConflict: 'user_id,artwork_id', ignoreDuplicates: true }));
      if (follows.length) check(await sb.from('follows').upsert(follows, { onConflict: 'user_id,artist_id', ignoreDuplicates: true }));
    },
  };
}
