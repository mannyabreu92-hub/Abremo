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

    /** Top Collectors, Critics and Discoverers (display names and scores only). */
    async leaderboards(country = null) {
      return check(await sb.rpc('member_leaderboards', { p_country: country, p_limit: 50 }));
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

    /** Public URL prefix for images in the artworks bucket. */
    storageBase: `${url.replace(/\/+$/, '')}/storage/v1/object/public/artworks/`,

    /** Upload the full image and thumbnail into the artist's own folder, then publish. */
    async publishArtwork({ image, thumb, width, height, title, category, style, medium, year, price }) {
      if (!user) throw new Error('Sign in first');
      const bucket = sb.storage.from('artworks');
      const id = crypto.randomUUID();
      const ext = image.type === 'image/webp' ? 'webp' : 'jpg';
      const imagePath = `${user.id}/${id}.${ext}`;
      const thumbPath = `${user.id}/${id}-thumb.${ext}`;
      const opts = (blob) => ({ contentType: blob.type, cacheControl: '31536000', upsert: false });
      check(await bucket.upload(imagePath, image, opts(image)));
      try {
        check(await bucket.upload(thumbPath, thumb, opts(thumb)));
        return check(await sb.rpc('publish_artwork', {
          p_title: title, p_category: category, p_style: style, p_medium: medium || '', p_year: year, p_price: price,
          p_image_path: imagePath, p_thumb_path: thumbPath, p_width: width, p_height: height,
        }));
      } catch (e) {
        await bucket.remove([imagePath, thumbPath]).catch(() => {});
        throw e;
      }
    },

    async deleteArtwork(id) {
      const rows = check(await sb.rpc('delete_artwork', { p_id: id }));
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) await sb.storage.from('artworks').remove([row.image_path, row.thumb_path].filter(Boolean)).catch(() => {});
    },

    async importGuest({ reactions, follows }) {
      if (reactions.length) check(await sb.from('reactions').upsert(reactions, { onConflict: 'user_id,artwork_id', ignoreDuplicates: true }));
      if (follows.length) check(await sb.from('follows').upsert(follows, { onConflict: 'user_id,artist_id', ignoreDuplicates: true }));
    },
  };
}
