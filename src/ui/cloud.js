// Community backend (Supabase). Every call the app makes to the server goes through this
// adapter, so the UI can be tested against a stand-in with the same methods.

// supabase-js 2.45.4 (MIT), served from this site rather than a CDN so the app runs only code we ship
// (and a strict Content-Security-Policy can allow scripts from 'self' only). See src/vendor/.
const SUPABASE_JS = new URL('../vendor/supabase.js', import.meta.url).href;

/** @returns {Promise<any>} the supabase-js UMD global */
function loadSupabase() {
  const g = /** @type {any} */ (self);
  if (g.supabase?.createClient) return Promise.resolve(g.supabase);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SUPABASE_JS;
    s.onload = () => (g.supabase?.createClient ? resolve(g.supabase) : reject(new Error('Sign-in library failed to start')));
    s.onerror = () => reject(new Error('Could not load the sign-in library'));
    document.head.append(s);
  });
}

const toUser = (session) => (session?.user ? { id: session.user.id, email: session.user.email || '' } : null);

function check({ data, error }) {
  if (error) throw Object.assign(new Error(error.message || 'Request failed'), { cause: error });
  return data;
}

export async function createSupabaseCloud(url, key) {
  const { createClient } = await loadSupabase();
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

    // ——— Critic & Collector applications ———
    async applyForRole(role, statement, links) {
      return check(await sb.rpc('apply_for_role', { p_role: role, p_statement: statement, p_links: links }));
    },
    async withdrawApplication(id) {
      check(await sb.rpc('withdraw_role_application', { p_id: id }));
    },
    async myApplications() {
      if (!user) return [];
      return check(await sb.from('role_applications').select('id, role, status, decision_note, created_at, decided_at').order('created_at', { ascending: false }));
    },
    async isAdmin() {
      return user ? Boolean(check(await sb.rpc('is_admin'))) : false;
    },
    async adminQueue() {
      return check(await sb.rpc('admin_role_queue'));
    },
    async decideApplication(id, approve, note) {
      return check(await sb.rpc('decide_role_application', { p_id: id, p_approve: approve, p_note: note || null }));
    },
    async verifiedMembers() {
      return check(await sb.rpc('admin_verified_members'));
    },
    async revokeRole(userId, note) {
      check(await sb.rpc('revoke_role', { p_user: userId, p_note: note || null }));
    },

    /** Top Collectors, Critics and Discoverers (display names and scores only). */
    async leaderboards(country = null) {
      return check(await sb.rpc('member_leaderboards', { p_country: country, p_limit: 50 }));
    },

    async snapshot() {
      return check(await sb.rpc('community_snapshot'));
    },

    /** The earlier hourly chart to compare rankings against: { hour, taken_at, snapshot } or null. */
    async chartBaseline() {
      return check(await sb.rpc('chart_baseline'));
    },

    /**
     * Live updates: calls onChange when community totals change (the database bumps a public
     * pulse row; no individual vote is sent), and onStatus(true/false) as the connection comes and goes.
     */
    /** @param {() => void} onChange @param {(connected: boolean) => void} [onStatus] */
    onPulse(onChange, onStatus = () => {}) {
      sb.channel('abremi-pulse')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'community_pulse' }, () => onChange())
        .subscribe((status) => onStatus(status === 'SUBSCRIBED'));
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

    /** Upload a portrait into the artist's own folder; returns its storage path. */
    async uploadPortrait(blob) {
      if (!user) throw new Error('Sign in first');
      const path = `${user.id}/portrait-${crypto.randomUUID()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
      check(await sb.storage.from('artworks').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false }));
      return path;
    },

    async updateArtistProfile({ bio, statement, website, instagram, city, avatarPath }) {
      return check(await sb.rpc('update_artist_profile', {
        p_bio: bio, p_statement: statement, p_website: website, p_instagram: instagram, p_city: city, p_avatar_path: avatarPath || null,
      }));
    },

    async updateArtwork(id, { title, category, style, medium, year, price, description, dimensions, availability }) {
      return check(await sb.rpc('update_artwork', {
        p_id: id, p_title: title, p_category: category, p_style: style, p_medium: medium || '', p_year: year, p_price: price,
        p_description: description || '', p_dimensions: dimensions || '', p_availability: availability || 'available',
      }));
    },

    // ——— Collections (private unless the owner shares them) ———
    async myCollections() {
      if (!user) return { collections: [], items: [] };
      const [collections, items] = await Promise.all([
        sb.from('collections').select('id, name, description, is_private, created_at').eq('owner_id', user.id).order('created_at'),
        sb.from('collection_items').select('collection_id, artwork_id, added_at, collections!inner(owner_id)').eq('collections.owner_id', user.id),
      ]);
      return { collections: check(collections), items: check(items).map(({ collection_id, artwork_id, added_at }) => ({ collection_id, artwork_id, added_at })) };
    },
    async createCollection({ name, description = '', isPrivate = true }) {
      return check(await sb.from('collections').insert({ name, description: description || null, is_private: isPrivate }).select('id, name, description, is_private, created_at').single());
    },
    async updateCollection(id, fields) {
      const row = {};
      if ('name' in fields) row.name = fields.name;
      if ('description' in fields) row.description = fields.description || null;
      if ('isPrivate' in fields) row.is_private = fields.isPrivate;
      check(await sb.from('collections').update(row).eq('id', id));
    },
    async deleteCollection(id) {
      check(await sb.from('collections').delete().eq('id', id));
    },
    async addToCollection(id, artworkId) {
      check(await sb.from('collection_items').upsert({ collection_id: id, artwork_id: artworkId }, { onConflict: 'collection_id,artwork_id', ignoreDuplicates: true }));
    },
    async removeFromCollection(id, artworkId) {
      check(await sb.from('collection_items').delete().eq('collection_id', id).eq('artwork_id', artworkId));
    },
    /** A shared collection (or your own private one). null when it's private or doesn't exist. */
    async publicCollection(id) {
      return check(await sb.rpc('public_collection', { p_id: id }));
    },
    // ——— Phase 2A: achievements and ranking integrity ———
    async achievementDefinitions() {
      return check(await sb.from('achievement_definitions').select('code, audience, label, criteria, sort').order('sort'));
    },
    async myAchievements() {
      return user ? check(await sb.rpc('my_achievements')) : [];
    },
    async artistAchievements(artistId) {
      return check(await sb.rpc('artist_achievements', { p_artist_id: artistId }));
    },
    async integrityQueue() {
      return check(await sb.rpc('admin_integrity_queue'));
    },
    async resolveFlag(id, exclude, note) {
      return check(await sb.rpc('resolve_integrity_flag', { p_id: id, p_exclude: exclude, p_note: note || null }));
    },
    // ——— Phase 2B: Artist Arena and Creative Challenges ———
    async arena() {
      return check(await sb.rpc('arena'));
    },
    async competition(id) {
      return check(await sb.rpc('competition_detail', { p_id: id }));
    },
    async createCompetition({ kind, title, brief, rules, category, country, entriesOpenAt, votingOpensAt, votingClosesAt }) {
      return check(await sb.rpc('create_competition', {
        p_kind: kind, p_title: title, p_brief: brief || '', p_rules: rules || '', p_category: category || '', p_country: country || '',
        p_entries_open_at: entriesOpenAt, p_voting_opens_at: votingOpensAt, p_voting_closes_at: votingClosesAt,
      }));
    },
    async cancelCompetition(id, note) {
      check(await sb.rpc('cancel_competition', { p_id: id, p_note: note || null }));
    },
    async enterCompetition(id, artworkId) {
      return check(await sb.rpc('enter_competition', { p_competition: id, p_artwork: artworkId }));
    },
    async withdrawEntry(id) {
      check(await sb.rpc('withdraw_entry', { p_competition: id }));
    },
    async voteCompetition(id, entryId) {
      check(await sb.rpc('cast_competition_vote', { p_competition: id, p_entry: entryId }));
    },
    async notifications() {
      if (!user) return [];
      return check(await sb.from('notifications').select('id, kind, title, link, created_at, read_at').order('created_at', { ascending: false }).limit(50));
    },
    async markNotificationsRead() {
      if (user) check(await sb.rpc('mark_notifications_read'));
    },
    // ——— Phase 3: Studio analytics ———
    /** events: [{ k, t }] (impression | artwork_view | profile_visit). Guests pass their device key. */
    async recordEvents(events, guestKey) {
      return check(await sb.rpc('record_events', { p_events: events, p_guest_key: user ? null : guestKey }));
    },
    async studio(days) {
      return check(await sb.rpc('studio_analytics', { p_days: days }));
    },
    async weeklyReports() {
      return check(await sb.rpc('my_weekly_reports'));
    },
    // ——— Phase 4: Collector Radar ———
    async sendInquiry({ artworkId = null, artistId = null, kind, message }) {
      return check(await sb.rpc('send_inquiry', { p_artwork: artworkId, p_artist: artistId, p_kind: kind, p_message: message }));
    },
    async replyInquiry(id, body) {
      check(await sb.rpc('reply_inquiry', { p_id: id, p_body: body }));
    },
    async setInquiryStatus(id, status) {
      check(await sb.rpc('set_inquiry_status', { p_id: id, p_status: status }));
    },
    async markInquiryRead(id) {
      check(await sb.rpc('mark_inquiry_read', { p_id: id }));
    },
    async inquiries() {
      return user ? check(await sb.rpc('my_inquiries')) : [];
    },
    async inquiryThread(id) {
      return check(await sb.rpc('inquiry_thread', { p_id: id }));
    },
    async setBlock(inquiryId, on) {
      check(await sb.rpc('set_block', { p_inquiry: inquiryId, p_block: on }));
    },
    async reportInquiry(id, reason) {
      check(await sb.rpc('report_inquiry', { p_id: id, p_reason: reason }));
    },
    async inquiryReports() {
      return check(await sb.rpc('admin_inquiry_reports'));
    },
    async resolveInquiryReport(id, close, note) {
      check(await sb.rpc('resolve_inquiry_report', { p_id: id, p_close: close, p_note: note || null }));
    },
    async collectorInterest() {
      return check(await sb.rpc('collector_interest'));
    },
    // ——— Phase 4: Drops ———
    async drops() {
      return check(await sb.rpc('drops_overview'));
    },
    async drop(id) {
      return check(await sb.rpc('drop_detail', { p_id: id }));
    },
    async createDrop({ title, description, releaseAt, artworkIds }) {
      return check(await sb.rpc('create_drop', { p_title: title, p_description: description || '', p_release_at: releaseAt, p_artworks: artworkIds, p_teaser: artworkIds[0] }));
    },
    async cancelDrop(id, note) {
      check(await sb.rpc('cancel_drop', { p_id: id, p_note: note || null }));
    },
    async subscribeDrop(id, on) {
      check(await sb.rpc('subscribe_drop', { p_id: id, p_on: on }));
    },
    async scheduledWorks() {
      return user ? check(await sb.rpc('my_scheduled_works')) : [];
    },
    // ——— Phase 5: Career Coach (server function api/coach.js), Passport, Opportunities ———
    async coachUsage() {
      return user ? check(await sb.rpc('coach_usage')) : null;
    },
    /** Asks the Coach (the AI runs on the server; the database checks limits). Returns { text, basedOn }. */
    async coach(tool, { artworkId = null, opportunityId = null } = {}) {
      const { data } = await sb.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Sign in first');
      const res = await fetch('api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool, artworkId, opportunityId }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'The Coach is unavailable right now.');
      return out;
    },
    async passport(artistId) {
      return check(await sb.rpc('artist_passport', { p_artist: artistId }));
    },
    async myExhibitions() {
      if (!user) return [];
      return check(await sb.from('exhibitions').select('id, kind, title, venue, city, start_date, end_date, link, status, review_note').eq('owner_id', user.id).order('start_date', { ascending: false }));
    },
    async submitExhibition({ kind, title, venue, city, country, start, end, link }) {
      return check(await sb.rpc('submit_exhibition', { p_kind: kind, p_title: title, p_venue: venue, p_city: city || null, p_country: country || null, p_start: start, p_end: end || null, p_link: link }));
    },
    async deleteExhibition(id) {
      check(await sb.rpc('delete_exhibition', { p_id: id }));
    },
    async exhibitionQueue() {
      return check(await sb.rpc('admin_exhibition_queue'));
    },
    async reviewExhibition(id, verify, note) {
      check(await sb.rpc('review_exhibition', { p_id: id, p_verify: verify, p_note: note || null }));
    },
    async opportunities() {
      return check(await sb.rpc('opportunities_list'));
    },
    async suggestOpportunity(o) {
      return check(await sb.rpc('suggest_opportunity', {
        p_kind: o.kind, p_title: o.title, p_organizer: o.organizer, p_location: o.location, p_deadline: o.deadline,
        p_eligibility: o.eligibility || '', p_description: o.description || '', p_fee: o.fee || 0, p_fee_currency: o.currency || 'USD', p_link: o.link,
      }));
    },
    async saveOpportunity(id, on) {
      check(await sb.rpc('save_opportunity', { p_id: id, p_on: on }));
    },
    async opportunityQueue() {
      return check(await sb.rpc('admin_opportunity_queue'));
    },
    async reviewOpportunity(id, approve, note) {
      check(await sb.rpc('review_opportunity', { p_id: id, p_approve: approve, p_note: note || null }));
    },
    async auditLog() {
      return check(await sb.rpc('admin_audit_log', { p_limit: 100 }));
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
