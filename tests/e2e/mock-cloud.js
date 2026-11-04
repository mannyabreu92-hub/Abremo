// In-browser stand-in for the Supabase backend, used by the end-to-end test.
// Same methods as src/ui/cloud.js; enforces the same rules as the SQL migration
// (server-stamped roles, critic-only reviews, admin-only Critic/Collector, Elo maths).
// Data lives in localStorage under "mockcloud" so it survives reloads and is shared by tabs.
window.__abremiCloud = async () => {
  const { buildSeedWorld } = await import('/src/core/seed.js');
  const { battleResult, expectedScore } = await import('/src/core/elo.js');
  const { memberBoards } = await import('/src/core/leaderboards.js');
  let clock = Date.now();
  const tick = () => ++clock;
  const seed = buildSeedWorld();
  const baseElo = Object.fromEntries(seed.artworks.map((w) => [w.id, 1200])); // the shared catalog starts every work at 1200
  const catalogArtist = Object.fromEntries(seed.artworks.map((w) => [w.id, w.artistId]));
  const W = { fan: 1, artist: 3, critic: 5, collector: 9 };
  const KEY = 'mockcloud';
  const load = () => ({ uploads: [], artists: {}, ...JSON.parse(localStorage.getItem(KEY) || '{"profiles":{},"reactions":[],"follows":[],"reviews":[],"ratings":{},"votes":[]}') });
  const toDataURL = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
  const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
  const SESSION = 'mockcloud-session';
  let user = JSON.parse(sessionStorage.getItem(SESSION) || localStorage.getItem(SESSION) || 'null');
  let listener = () => {};
  const wait = () => new Promise((r) => setTimeout(r, 30));
  const needUser = () => { if (!user) throw new Error('Sign in first'); };
  // Same neutral default name as the database: never part of the email address.
  const profileOf = (db, id) => (db.profiles[id] ||= { id, created_at: new Date().toISOString(), name: `Member ${[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).toUpperCase().slice(0, 4).padEnd(4, '0')}`, country: 'US', role: 'fan', public_leaderboards: true });
  window.__mockdb = { load, save };
  const group = (rows, keyFn) => Object.values(rows.reduce((m, r) => { const k = keyFn(r); (m[k.key] ||= { ...k.out, n: 0 }).n++; return m; }, {}));
  // Same rules as 0007: own work and moderator-excluded reactions don't count; neither do self-follows.
  const ownerOf = (db, artworkId) => db.uploads.find((u) => u.id === artworkId)?.owner || null;
  const counted = (db) => db.reactions.filter((r) => !r.excluded && ownerOf(db, r.artwork_id) !== r.user_id);
  const countedFollows = (db) => db.follows.filter((f) => f.artist_id !== `m_${f.user_id}`);
  const scoresOf = (db) => {
    const now = Date.now(), m = {};
    const row = (a) => (m[a] ||= { a, p: 0, t: 0, c: 0, cr: 0 });
    for (const r of counted(db)) {
      if (r.kind === 'pass') continue;
      const pts = W[r.role] * (r.kind === 'super' ? 2 : 1);
      const x = row(r.artwork_id);
      x.p += pts;
      x.t += pts * 0.5 ** ((now - (r.at || now)) / (7 * 86400e3));
      if (r.role === 'collector') x.c += pts;
    }
    for (const v of db.reviews) { if (ownerOf(db, v.artwork_id) !== v.user_id) { row(v.artwork_id).p += 2 * v.rating; row(v.artwork_id).cr += 2 * v.rating; } }
    const scores = Object.values(m).map((x) => ({ ...x, p: Math.round(x.p), t: Math.round(x.t * 100) / 100 }));
    const rep = {};
    for (const x of scores) { const artist = catalogArtist[x.a] || db.uploads.find((u) => u.id === x.a)?.artist_id; if (artist) rep[artist] = (rep[artist] || 0) + x.p; }
    for (const f of countedFollows(db)) rep[f.artist_id] = (rep[f.artist_id] || 0) + W[f.role];
    return { scores, artist_scores: Object.entries(rep).filter(([, s]) => s > 0).map(([a, s]) => ({ a, s })) };
  };
  // Competitions (0008): phases follow the schedule; closing records places and announces results once.
  const phaseOf = (c, now = Date.now()) => (c.cancelled_at ? 'cancelled' : now < Date.parse(c.entries_open_at) ? 'upcoming'
    : now < Date.parse(c.voting_opens_at) ? 'entries' : now < Date.parse(c.voting_closes_at) ? 'voting' : 'closed');
  const pick = (c) => ({ id: c.id, kind: c.kind, title: c.title, brief: c.brief, category: c.category, country: c.country,
    entries_open_at: c.entries_open_at, voting_opens_at: c.voting_opens_at, voting_closes_at: c.voting_closes_at });
  const eligibility = (db, uid) => {
    if (!uid) return 'Sign in to vote';
    if (Date.parse(profileOf(db, uid).created_at) > Date.now() - 3 * 86400e3) return 'New accounts can vote after 3 days';
    if (counted(db).filter((r) => r.user_id === uid && r.kind !== 'pass').length < 5) return 'Like at least 5 works to vote';
    return null;
  };
  const award = (db, uid, code, evidence) => { ((db.achievements ||= {})[uid] ||= {})[code] ||= { code, awarded_at: new Date().toISOString(), evidence }; };
  const closeDue = (db) => {
    let changed = false;
    for (const c of db.competitions || []) {
      if (c.closed_at || c.cancelled_at || phaseOf(c) !== 'closed') continue;
      const entries = (db.entries || []).filter((e) => e.competition_id === c.id)
        .map((e) => ({ e, votes: (db.compVotes || []).filter((v) => v.entry_id === e.id).length }))
        .sort((a, b) => b.votes - a.votes || a.e.at - b.e.at);
      const res = entries.map(({ e, votes }) => ({ entry: e.id, artwork: e.artwork_id, votes, place: votes > 0 ? 1 + entries.filter((x) => x.votes > votes).length : null }));
      c.closed_at = new Date().toISOString();
      c.results = { entries: res, voters: (db.compVotes || []).filter((v) => v.competition_id === c.id).length };
      db.notifications ||= [];
      for (const r of res) {
        const e = entries.find((x) => x.e.id === r.entry).e;
        if (r.place === 1) award(db, e.user_id, 'competition_winner', { competition: c.id });
        if (r.place && r.place <= 3) award(db, e.user_id, 'podium_finish', { competition: c.id });
        const ord = r.place === 1 ? '1st' : r.place === 2 ? '2nd' : r.place === 3 ? '3rd' : `${r.place}th`;
        db.notifications.push({ id: crypto.randomUUID(), user_id: e.user_id, kind: 'competition_result', title: r.place ? `Your entry placed ${ord} in “${c.title}”` : `Results are in for “${c.title}”`, link: `competition/${c.id}`, created_at: new Date().toISOString(), read_at: null });
      }
      changed = true;
    }
    if (changed) save(db);
  };
  const snapshotOf = (db) => ({
    ...scoresOf(db),
    reactions: group(counted(db).filter((r) => r.kind !== 'pass'), (r) => ({ key: `${r.artwork_id}|${r.kind}|${r.role}`, out: { a: r.artwork_id, k: r.kind, r: r.role } })),
    reviews: Object.values(db.reviews.reduce((m, r) => { (m[r.artwork_id] ||= { a: r.artwork_id, n: 0, s: 0 }); m[r.artwork_id].n++; m[r.artwork_id].s += r.rating; return m; }, {})),
    follows: group(countedFollows(db), (f) => ({ key: `${f.artist_id}|${f.role}`, out: { a: f.artist_id, r: f.role } })),
    ratings: Object.entries(db.ratings).map(([a, v]) => ({ a, v })),
    members: Object.keys(db.profiles).length,
    artists: Object.values(db.artists),
    uploads: db.uploads.slice().reverse().map(({ owner, image_type, image_bytes, ...u }) => u),
  });

  return {
    kind: 'mock',
    async init() { await wait(); return user; },
    onAuth(cb) { listener = cb; },
    async sendLink(email) { await wait(); window.__lastEmail = email; },
    async verifyCode(email, code) {
      await wait();
      if (code !== '123456') throw new Error('Token has expired or is invalid');
      user = { id: `u-${email}`, email };
      localStorage.setItem(SESSION, JSON.stringify(user));
      const db = load(); profileOf(db, user.id); save(db);
      setTimeout(() => listener(user, 'SIGNED_IN'), 0);
      return user;
    },
    async signOut() { user = null; localStorage.removeItem(SESSION); setTimeout(() => listener(null, 'SIGNED_OUT'), 0); },
    async snapshot() {
      await wait();
      return snapshotOf(load());
    },
    // ——— Live updates (same rules as supabase/migrations/0005_live_updates.sql) ———
    async chartBaseline() {
      await wait();
      const db = load();
      db.history ||= [];
      const hour = new Date(); hour.setMinutes(0, 0, 0);
      const h = hour.getTime();
      if (!db.history.some((x) => Date.parse(x.hour) === h)) {
        const { uploads, artists, ...totals } = snapshotOf(db);
        db.history.push({ hour: hour.toISOString(), taken_at: new Date().toISOString(), snapshot: totals });
        save(db);
      }
      const earlier = db.history.filter((x) => Date.parse(x.hour) < h && Date.parse(x.hour) >= h - 24 * 3600e3)
        .sort((a, b) => Date.parse(b.hour) - Date.parse(a.hour));
      return earlier[0] || null;
    },
    // Another tab writing the shared data stands in for the database's pulse row.
    onPulse(onChange, onStatus = () => {}) {
      window.addEventListener('storage', (e) => { if (e.key === KEY) onChange(); });
      setTimeout(() => onStatus(true), 0);
    },
    // ——— Critic & Collector applications (same rules as supabase/migrations/0004_role_applications.sql) ———
    async applyForRole(role, statement, links = []) {
      needUser(); await wait();
      const db = load();
      db.applications ||= [];
      const p = profileOf(db, user.id);
      if (!['critic', 'collector'].includes(role)) throw new Error('You can apply to be a Critic or a Collector');
      if (p.role === role) throw new Error('You already have this role');
      if (db.applications.some((a) => a.user_id === user.id && a.role === role && a.status === 'pending')) throw new Error('You already have a pending application for this role');
      if (db.applications.filter((a) => a.user_id === user.id).length >= 3) throw new Error('You can send three applications every 30 days');
      if (statement.trim().length < 40) throw new Error('new row violates check constraint');
      if (links.some((l) => !/^https:\/\/\S+$/.test(l))) throw new Error('Links must start with https://');
      const app = { id: crypto.randomUUID(), user_id: user.id, role, statement: statement.trim(), links, status: 'pending', decision_note: null, created_at: new Date().toISOString(), decided_at: null };
      db.applications.push(app);
      save(db);
      return app;
    },
    async withdrawApplication(id) {
      needUser(); await wait();
      const db = load();
      const a = (db.applications || []).find((x) => x.id === id && x.user_id === user.id && x.status === 'pending');
      if (!a) throw new Error('No pending application to withdraw');
      a.status = 'withdrawn';
      save(db);
    },
    async myApplications() {
      await wait();
      if (!user) return [];
      return (load().applications || []).filter((a) => a.user_id === user.id).slice().reverse();
    },
    async isAdmin() { return Boolean(user && (load().admins || []).includes(user.id)); },
    async adminQueue() {
      await wait();
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      return (db.applications || []).filter((a) => a.status === 'pending').map((a) => {
        const p = profileOf(db, a.user_id);
        const mine = db.reactions.filter((r) => r.user_id === a.user_id);
        return { ...a, applicant_name: p.name, applicant_country: p.country, applicant_role: p.role, email: a.user_id.replace(/^u-/, ''), member_since: new Date().toISOString(),
          likes: mine.filter((r) => r.kind === 'like').length, saves: mine.filter((r) => r.kind === 'super').length, reviews: db.reviews.filter((r) => r.user_id === a.user_id).length,
          influence_added: mine.length, follows: 0, previous_declines: (db.applications || []).filter((d) => d.user_id === a.user_id && d.status === 'declined').length };
      });
    },
    async decideApplication(id, approve, note) {
      await wait();
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      const a = (db.applications || []).find((x) => x.id === id && x.status === 'pending');
      if (!a) throw new Error('That application is no longer pending');
      Object.assign(a, { status: approve ? 'approved' : 'declined', decision_note: note || null, decided_at: new Date().toISOString() });
      if (approve) profileOf(db, a.user_id).role = a.role;
      save(db);
      return a;
    },
    async verifiedMembers() {
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      return Object.values(db.profiles).filter((p) => p.role === 'critic' || p.role === 'collector')
        .map((p) => ({ user_id: p.id, name: p.name, country: p.country, role: p.role, email: p.id.replace(/^u-/, ''), approved_at: null }));
    },
    async revokeRole(userId) {
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      const p = db.profiles[userId];
      if (!p || !['critic', 'collector'].includes(p.role)) throw new Error('That member has no verified role');
      p.role = 'fan';
      save(db);
    },
    async leaderboards(country = null) {
      await wait();
      const db = load();
      return memberBoards({
        profiles: Object.values(db.profiles).map((p) => ({ id: p.id, name: p.name, country: p.country, role: p.role, public: p.public_leaderboards !== false })),
        reactions: db.reactions.map((r) => ({ user: r.user_id, artwork: r.artwork_id, kind: r.kind, role: r.role, at: r.at || 0 })),
        reviews: db.reviews.map((r) => ({ user: r.user_id, rating: r.rating })),
      }, { me: user?.id || null, country });
    },
    async profile() { needUser(); const db = load(); const isNew = !db.profiles[user.id]; const p = profileOf(db, user.id); if (isNew) save(db); return p; },
    async mine() {
      await wait();
      if (!user) return { reactions: [], follows: [], reviews: [] };
      const db = load();
      return {
        reactions: db.reactions.filter((r) => r.user_id === user.id),
        follows: db.follows.filter((f) => f.user_id === user.id),
        reviews: db.reviews.filter((r) => r.user_id === user.id),
      };
    },
    async setReaction(artwork_id, kind) {
      needUser(); await wait();
      const db = load();
      const existing = db.reactions.find((r) => r.user_id === user.id && r.artwork_id === artwork_id);
      if (existing && kind) Object.assign(existing, { kind, role: profileOf(db, user.id).role }); // an update keeps any exclusion
      else {
        db.reactions = db.reactions.filter((r) => r !== existing);
        if (kind) db.reactions.push({ user_id: user.id, artwork_id, kind, role: profileOf(db, user.id).role, at: tick() });
      }
      save(db);
    },
    async setFollow(artist_id, on) {
      needUser(); await wait();
      const db = load();
      db.follows = db.follows.filter((f) => !(f.user_id === user.id && f.artist_id === artist_id));
      if (on) db.follows.push({ user_id: user.id, artist_id, role: profileOf(db, user.id).role, at: tick() });
      save(db);
    },
    async addReview(artwork_id, rating, body) {
      needUser(); await wait();
      const db = load();
      if (profileOf(db, user.id).role !== 'critic') throw new Error('new row violates row-level security policy for table "reviews"');
      db.reviews.push({ user_id: user.id, artwork_id, rating, body, role: 'critic', created_at: new Date().toISOString() });
      save(db);
    },
    async vote(w, l) {
      needUser(); await wait();
      const db = load();
      const role = profileOf(db, user.id).role;
      if (ownerOf(db, w) === user.id) throw new Error('You can’t vote for your own work');
      const wr = db.ratings[w] ?? baseElo[w] ?? 1200, lr = db.ratings[l] ?? baseElo[l] ?? 1200;
      const r = battleResult(wr, lr, role);
      db.ratings[w] = r.winner; db.ratings[l] = r.loser;
      db.votes.push({ user_id: user.id, w, l, role });
      save(db);
      return { winner_rating: r.winner, loser_rating: r.loser, gain: r.gain, loss: r.loss, crowd: Math.round(expectedScore(wr, lr) * 100) };
    },
    async updateProfile(fields) {
      needUser(); await wait();
      const db = load();
      const p = profileOf(db, user.id);
      if (fields.role && ['critic', 'collector'].includes(fields.role) && fields.role !== p.role) throw new Error('Critic and Collector roles require verification');
      Object.assign(p, fields);
      const artist = db.artists[`m_${user.id}`];
      if (artist) Object.assign(artist, { name: p.name, country: p.country });
      save(db);
      return p;
    },
    storageBase: '',
    async publishArtwork({ image, thumb, width, height, title, category, style, medium, year, price }) {
      needUser(); await wait();
      const db = load();
      const p = profileOf(db, user.id);
      if (p.role !== 'artist') throw new Error('Switch to the Artist role to publish work');
      if (!/^image\/(webp|jpeg|png)$/.test(image.type) || image.size > 5 * 1024 * 1024) throw new Error('Image rejected by storage');
      const id = `u_${crypto.randomUUID().replace(/-/g, '')}`;
      const artistId = `m_${user.id}`;
      db.artists[artistId] = { created_at: new Date().toISOString(), ...db.artists[artistId], id: artistId, name: p.name, country: p.country };
      db.uploads.push({ id, artist_id: artistId, owner: user.id, title: title.trim(), category, style, medium, year, price,
        image_path: await toDataURL(image), thumb_path: await toDataURL(thumb), width, height, created_at: new Date().toISOString(),
        image_type: image.type, image_bytes: image.size });
      save(db);
      return { id };
    },
    async deleteArtwork(id) {
      needUser(); await wait();
      const db = load();
      const work = db.uploads.find((u) => u.id === id);
      if (!work || work.owner !== user.id) throw new Error('Not your artwork');
      db.uploads = db.uploads.filter((u) => u.id !== id);
      db.reactions = db.reactions.filter((r) => r.artwork_id !== id);
      delete db.ratings[id];
      save(db);
    },
    // ——— Phase 1 (same rules as supabase/migrations/0006_profiles_artworks_collections.sql) ———
    async uploadPortrait(blob) {
      needUser(); await wait();
      if (!/^image\/(webp|jpeg|png)$/.test(blob.type)) throw new Error('Image rejected by storage');
      return toDataURL(blob);
    },
    async updateArtistProfile({ bio = '', statement = '', website = '', instagram = '', city = '', avatarPath = null }) {
      needUser(); await wait();
      const db = load();
      const p = profileOf(db, user.id);
      const artistId = `m_${user.id}`;
      if (!db.artists[artistId] && p.role !== 'artist') throw new Error('Switch to the Artist role to set up an artist profile');
      const handle = instagram.trim().replace(/^@/, '');
      if (bio.length > 1000 || statement.length > 2000 || city.length > 60 || (website.trim() && !/^https:\/\/[^\s<>"]+$/.test(website.trim()))
        || (handle && !/^[A-Za-z0-9._]{1,30}$/.test(handle))) throw new Error('new row for relation "artists" violates check constraint "artists_profile_valid"');
      db.artists[artistId] = { ...(db.artists[artistId] || { id: artistId, created_at: new Date().toISOString() }), name: p.name, country: p.country,
        bio: bio.trim() || null, statement: statement.trim() || null, website: website.trim() || null, instagram: handle || null, city: city.trim() || null, avatar_path: avatarPath || null };
      db.audit ||= [];
      save(db);
      return db.artists[artistId];
    },
    async updateArtwork(id, { title, category, style, medium, year, price, description = '', dimensions = '', availability = 'available' }) {
      needUser(); await wait();
      const db = load();
      const w = db.uploads.find((u) => u.id === id);
      if (!w || w.owner !== user.id) throw new Error('Not your artwork');
      if (!['available', 'sold', 'not_for_sale', 'on_request'].includes(availability) || description.length > 2000 || dimensions.length > 60) throw new Error('violates check constraint "artworks_details_valid"');
      Object.assign(w, { title: title.trim(), category, style, medium, year, price, description: description.trim() || null, dimensions: dimensions.trim() || null, availability });
      save(db);
      return w;
    },
    async myCollections() {
      await wait();
      if (!user) return { collections: [], items: [] };
      const db = load();
      const mine = (db.collections || []).filter((c) => c.owner_id === user.id);
      const ids = new Set(mine.map((c) => c.id));
      return { collections: mine, items: (db.collectionItems || []).filter((i) => ids.has(i.collection_id)) };
    },
    async createCollection({ name, description = '', isPrivate = true }) {
      needUser(); await wait();
      const db = load();
      db.collections ||= [];
      if (!name.trim() || name.trim().length > 60) throw new Error('violates check constraint "collections_name_check"');
      if (db.collections.filter((c) => c.owner_id === user.id).length >= 100) throw new Error('You can have up to 100 collections');
      const row = { id: crypto.randomUUID(), owner_id: user.id, name: name.trim(), description: description || null, is_private: isPrivate !== false, created_at: new Date().toISOString() };
      db.collections.push(row);
      save(db);
      return row;
    },
    async updateCollection(id, fields) {
      needUser(); await wait();
      const db = load();
      const c = (db.collections || []).find((x) => x.id === id && x.owner_id === user.id);
      if (!c) return; // RLS: someone else's collection updates nothing
      if ('name' in fields) c.name = fields.name.trim();
      if ('description' in fields) c.description = fields.description || null;
      if ('isPrivate' in fields) c.is_private = fields.isPrivate;
      save(db);
    },
    async deleteCollection(id) {
      needUser(); await wait();
      const db = load();
      db.collections = (db.collections || []).filter((c) => !(c.id === id && c.owner_id === user.id));
      db.collectionItems = (db.collectionItems || []).filter((i) => db.collections.some((c) => c.id === i.collection_id));
      save(db);
    },
    async addToCollection(id, artworkId) {
      needUser(); await wait();
      const db = load();
      if (!(db.collections || []).some((c) => c.id === id && c.owner_id === user.id)) throw new Error('new row violates row-level security policy for table "collection_items"');
      db.collectionItems ||= [];
      if (!db.collectionItems.some((i) => i.collection_id === id && i.artwork_id === artworkId)) db.collectionItems.push({ collection_id: id, artwork_id: artworkId, added_at: new Date(tick()).toISOString() });
      save(db);
    },
    async removeFromCollection(id, artworkId) {
      needUser(); await wait();
      const db = load();
      if (!(db.collections || []).some((c) => c.id === id && c.owner_id === user.id)) return;
      db.collectionItems = (db.collectionItems || []).filter((i) => !(i.collection_id === id && i.artwork_id === artworkId));
      save(db);
    },
    async publicCollection(id) {
      await wait();
      const db = load();
      const c = (db.collections || []).find((x) => x.id === id);
      if (!c || (c.is_private && c.owner_id !== user?.id)) return null;
      return { id: c.id, name: c.name, description: c.description, is_private: c.is_private, owner_name: profileOf(db, c.owner_id).name, mine: c.owner_id === user?.id,
        items: (db.collectionItems || []).filter((i) => i.collection_id === id).sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at)).map((i) => i.artwork_id) };
    },
    // ——— Phase 2A (same rules as 0007, for the achievements and flags the tests use) ———
    async achievementDefinitions() {
      return [
        { code: 'first_discovery', audience: 'member', label: 'First Discovery', criteria: 'Liked or saved your first work.', sort: 10 },
        { code: 'master_curator', audience: 'member', label: 'Master Curator', criteria: 'Built 3 collections with at least 5 works each.', sort: 30 },
        { code: 'first_work', audience: 'artist', label: 'First Work', criteria: 'Published a first work on Abremi.', sort: 100 },
        { code: 'first_entry', audience: 'artist', label: 'First Entry', criteria: 'Entered a first Arena competition or Creative Challenge.', sort: 150 },
        { code: 'podium_finish', audience: 'artist', label: 'Podium Finish', criteria: 'Placed in the top 3 of an Arena competition or Creative Challenge.', sort: 160 },
        { code: 'competition_winner', audience: 'artist', label: 'Competition Winner', criteria: 'Won an Arena competition or Creative Challenge (1st place, ties included).', sort: 170 },
      ];
    },
    async myAchievements() {
      await wait();
      if (!user) return [];
      const db = load();
      db.achievements ||= {};
      const mine = (db.achievements[user.id] ||= {});
      let changed = false;
      const award = (code, evidence) => { if (!mine[code]) { mine[code] = { code, awarded_at: new Date().toISOString(), evidence }; changed = true; } };
      const first = counted(db).find((r) => r.user_id === user.id && r.kind !== 'pass');
      if (first) award('first_discovery', { artwork: first.artwork_id });
      const work = db.uploads.find((u) => u.owner === user.id);
      if (work) award('first_work', { artwork: work.id });
      if (changed) save(db); // only write when something changed (tabs share this store)
      const defs = await this.achievementDefinitions();
      return Object.values(mine).map((m) => ({ ...defs.find((d) => d.code === m.code), ...m }));
    },
    async artistAchievements(artistId) {
      await wait();
      const db = load();
      const owner = artistId.startsWith('m_') ? artistId.slice(2) : null;
      const earned = Object.values((db.achievements || {})[owner] || {});
      const defs = await this.achievementDefinitions();
      return earned.map((m) => defs.find((d) => d.code === m.code)).filter((d) => d?.audience === 'artist');
    },
    async integrityQueue() {
      await wait();
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      db.flags ||= [];
      let added = false;
      const hourAgo = Date.now() - 3600e3;
      const byWork = {};
      for (const r of counted(db)) if (r.kind !== 'pass' && (r.at || 0) > hourAgo) (byWork[r.artwork_id] ||= []).push(r);
      for (const [id, rows] of Object.entries(byWork)) {
        const fresh = rows.filter((r) => Date.parse(profileOf(db, r.user_id).created_at) > (r.at || 0) - 72 * 3600e3).length;
        if (rows.length >= 10 && fresh / rows.length >= 0.6 && !db.flags.some((f) => f.target_id === id)) {
          added = true; db.flags.push({ id: crypto.randomUUID(), kind: 'new_account_burst', target_type: 'artwork', target_id: id, status: 'open', created_at: new Date().toISOString(),
            details: { total: rows.length, new_accounts: fresh, since: Math.min(...rows.map((r) => r.at)), until: Math.max(...rows.map((r) => r.at)) } });
        }
      }
      if (added) save(db);
      const titles = Object.fromEntries(seed.artworks.map((w) => [w.id, w.title]));
      return db.flags.filter((f) => f.status === 'open').map((f) => ({ ...f, title: titles[f.target_id] || f.target_id }));
    },
    async resolveFlag(id, exclude, note) {
      await wait();
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      const f = (db.flags || []).find((x) => x.id === id && x.status === 'open');
      if (!f) throw new Error('That flag is no longer open');
      f.status = exclude ? 'confirmed' : 'dismissed';
      let n = 0;
      if (exclude) {
        for (const r of db.reactions) {
          if (r.artwork_id === f.target_id && !r.excluded && r.at >= f.details.since && r.at <= f.details.until
              && Date.parse(profileOf(db, r.user_id).created_at) > r.at - 72 * 3600e3) { r.excluded = true; n++; }
        }
      }
      (db.audit ||= []).unshift({ action: exclude ? 'integrity_flag.confirmed' : 'integrity_flag.dismissed', actor_email: user.email, created_at: new Date().toISOString(), details: { excluded: n, note } });
      save(db);
      return n;
    },
    // ——— Phase 2B (same rules as supabase/migrations/0008_competitions.sql) ———
    async arena() {
      await wait();
      const db = load();
      closeDue(db);
      return (db.competitions || []).slice().sort((a, b) => Date.parse(b.voting_closes_at) - Date.parse(a.voting_closes_at)).map((c) => ({
        ...pick(c), phase: phaseOf(c),
        entries: (db.entries || []).filter((e) => e.competition_id === c.id).length,
        my_entry: (db.entries || []).find((e) => e.competition_id === c.id && e.user_id === user?.id)?.artwork_id || null,
        winner: c.results?.entries.find((r) => r.place === 1)?.artwork || null,
      }));
    },
    async competition(id) {
      await wait();
      const db = load();
      closeDue(db);
      const c = (db.competitions || []).find((x) => x.id === id);
      if (!c) return null;
      const why = eligibility(db, user?.id);
      return { ...pick(c), rules: c.rules, phase: phaseOf(c), results: c.results || null,
        entries: (db.entries || []).filter((e) => e.competition_id === id).map((e) => ({ id: e.id, artwork: e.artwork_id, mine: e.user_id === user?.id })),
        my_vote: (db.compVotes || []).find((v) => v.competition_id === id && v.user_id === user?.id)?.entry_id || null,
        can_vote: !why, vote_blocker: why };
    },
    async createCompetition({ kind, title, brief = '', rules = '', category = '', country = '', entriesOpenAt, votingOpensAt, votingClosesAt }) {
      await wait();
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      if (!(Date.parse(entriesOpenAt) < Date.parse(votingOpensAt) && Date.parse(votingOpensAt) < Date.parse(votingClosesAt))) throw new Error('new row for relation "competitions" violates check constraint "competitions_schedule"');
      if ((kind === 'category') !== Boolean(category) || (kind === 'country') !== Boolean(country)) throw new Error('violates check constraint "competitions_scope"');
      const c = { id: crypto.randomUUID(), kind, title: title.trim(), brief, rules, category: category || null, country: country || null,
        entries_open_at: new Date(entriesOpenAt).toISOString(), voting_opens_at: new Date(votingOpensAt).toISOString(), voting_closes_at: new Date(votingClosesAt).toISOString() };
      (db.competitions ||= []).push(c);
      (db.audit ||= []).unshift({ action: 'competition.created', actor_email: user.email, created_at: new Date().toISOString(), details: { title: c.title } });
      save(db);
      return c;
    },
    async cancelCompetition(id) {
      await wait();
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      const c = db.competitions.find((x) => x.id === id && !x.cancelled_at && !x.closed_at);
      if (!c) throw new Error('That competition has already ended');
      c.cancelled_at = new Date().toISOString();
      save(db);
    },
    async enterCompetition(id, artworkId) {
      needUser(); await wait();
      const db = load();
      const c = (db.competitions || []).find((x) => x.id === id);
      if (!c) throw new Error('Competition not found');
      if (phaseOf(c) !== 'entries') throw new Error('Entries are not open');
      const w = db.uploads.find((u) => u.id === artworkId);
      if (!w || w.owner !== user.id) throw new Error('You can only enter your own published work');
      if (c.kind === 'category' && w.category !== c.category) throw new Error('This competition is for a different medium');
      if (c.kind === 'country' && profileOf(db, user.id).country !== c.country) throw new Error('This competition is for artists from another country');
      db.entries ||= [];
      if (db.entries.some((e) => e.competition_id === id && e.user_id === user.id)) throw new Error('You already have an entry in this competition');
      const e = { id: crypto.randomUUID(), competition_id: id, artwork_id: artworkId, user_id: user.id, at: tick() };
      db.entries.push(e);
      award(db, user.id, 'first_entry', { competition: id });
      save(db);
      return e;
    },
    async withdrawEntry(id) {
      needUser(); await wait();
      const db = load();
      const c = (db.competitions || []).find((x) => x.id === id);
      if (!c || phaseOf(c) !== 'entries') throw new Error('Entries can be withdrawn only while entries are open');
      db.entries = (db.entries || []).filter((e) => !(e.competition_id === id && e.user_id === user.id));
      save(db);
    },
    async voteCompetition(id, entryId) {
      needUser(); await wait();
      const db = load();
      const c = (db.competitions || []).find((x) => x.id === id);
      if (!c || phaseOf(c) !== 'voting') throw new Error('Voting is not open');
      const why = eligibility(db, user.id);
      if (why) throw new Error(why);
      const e = (db.entries || []).find((x) => x.id === entryId && x.competition_id === id);
      if (!e) throw new Error('That entry is not in this competition');
      if (e.user_id === user.id) throw new Error('You can’t vote for your own entry');
      db.compVotes = (db.compVotes || []).filter((v) => !(v.competition_id === id && v.user_id === user.id));
      db.compVotes.push({ competition_id: id, user_id: user.id, entry_id: entryId });
      save(db);
    },
    async notifications() {
      await wait();
      return user ? (load().notifications || []).filter((n) => n.user_id === user.id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) : [];
    },
    async markNotificationsRead() {
      const db = load();
      for (const n of db.notifications || []) if (n.user_id === user?.id && !n.read_at) n.read_at = new Date().toISOString();
      save(db);
    },
    // ——— Phase 3 (same rules as supabase/migrations/0009_analytics.sql) ———
    async recordEvents(events, guestKey) {
      await wait();
      const db = load();
      db.events ||= [];
      const viewer = user ? user.id : /^[A-Za-z0-9-]{16,64}$/.test(guestKey || '') ? `g:${guestKey}` : null;
      if (!viewer || events.length > 100) return 0;
      const day = new Date().toISOString().slice(0, 10);
      let n = 0;
      for (const { k, t } of events) {
        const work = db.uploads.find((u) => u.id === t);
        const artistId = k === 'profile_visit' ? t : work?.artist_id;
        const owner = artistId?.startsWith('m_') ? artistId.slice(2) : null;
        if (!['impression', 'artwork_view', 'profile_visit'].includes(k) || !owner || owner === user?.id) continue;
        if (db.events.some((e) => e.k === k && e.t === t && e.viewer === viewer && e.day === day)) continue;
        const p = user ? profileOf(db, user.id) : null;
        db.events.push({ k, t, artist: artistId, artwork: work?.id || null, viewer, member: Boolean(user), role: p?.role || null, country: p?.country || null, day, at: Date.now() });
        n++;
      }
      if (n) save(db);
      return n;
    },
    async studio(days = 30) {
      await wait();
      needUser();
      const db = load();
      const artist = `m_${user.id}`;
      if (!db.artists[artist]) return null;
      days = [7, 30, 90].includes(days) ? days : 30;
      const DAY = 864e5, end = new Date(new Date().toISOString().slice(0, 10)).getTime() + DAY;
      const from = end - days * DAY, prev = from - days * DAY;
      const evs = (db.events || []).filter((e) => e.artist === artist);
      const mine = db.uploads.filter((u) => u.artist_id === artist).map((u) => u.id);
      const reacts = counted(db).filter((r) => mine.includes(r.artwork_id) && r.kind !== 'pass');
      const fol = countedFollows(db).filter((f) => f.artist_id === artist);
      const split = (k, a, b) => { const xs = evs.filter((e) => e.k === k && e.at >= a && e.at < b); return { members: xs.filter((e) => e.member).length, guests: xs.filter((e) => !e.member).length }; };
      const summary = (a, b) => ({ impressions: split('impression', a, b), views: split('artwork_view', a, b), visits: split('profile_visit', a, b),
        likes: reacts.filter((r) => r.kind === 'like' && (r.at || 0) >= a && (r.at || 0) < b).length,
        saves: reacts.filter((r) => r.kind === 'super' && (r.at || 0) >= a && (r.at || 0) < b).length,
        followers: fol.filter((f) => (f.at || 0) >= a && (f.at || 0) < b).length });
      const daily = Array.from({ length: days }, (_, i) => {
        const a = from + i * DAY, b = a + DAY;
        return { day: new Date(a).toISOString().slice(0, 10), impressions: evs.filter((e) => e.k === 'impression' && e.at >= a && e.at < b).length,
          views: evs.filter((e) => e.k === 'artwork_view' && e.at >= a && e.at < b).length, visits: evs.filter((e) => e.k === 'profile_visit' && e.at >= a && e.at < b).length,
          likes: reacts.filter((r) => (r.at || 0) >= a && (r.at || 0) < b).length, followers: fol.filter((f) => (f.at || 0) < b).length };
      });
      const works = db.uploads.filter((u) => u.artist_id === artist).map((u) => ({ id: u.id, title: u.title,
        impressions: evs.filter((e) => e.artwork === u.id && e.k === 'impression' && e.at >= from).length,
        views: evs.filter((e) => e.artwork === u.id && e.k === 'artwork_view' && e.at >= from).length,
        likes: reacts.filter((r) => r.artwork_id === u.id && r.kind === 'like' && (r.at || 0) >= from).length,
        saves: reacts.filter((r) => r.artwork_id === u.id && r.kind === 'super' && (r.at || 0) >= from).length }));
      const people = new Set([...reacts.filter((r) => (r.at || 0) >= from).map((r) => r.user_id), ...fol.filter((f) => (f.at || 0) >= from).map((f) => f.user_id), ...evs.filter((e) => e.member && e.at >= from).map((e) => e.viewer)]);
      const byCountry = {};
      for (const id of people) { const c = profileOf(db, id).country; byCountry[c] = (byCountry[c] || 0) + 1; }
      const grouped = {};
      for (const [c, n] of Object.entries(byCountry)) grouped[n >= 3 ? c : 'Other'] = (grouped[n >= 3 ? c : 'Other'] || 0) + n;
      const roles = {};
      for (const x of [...reacts.filter((r) => (r.at || 0) >= from), ...fol.filter((f) => (f.at || 0) >= from)]) roles[x.role] = (roles[x.role] || 0) + 1;
      return { artist, days, current: summary(from, end), previous: summary(prev, from), followers_total: fol.length, daily, works, roles,
        countries: Object.entries(grouped).map(([country, n]) => ({ country, people: n })).sort((a, b) => b.people - a.people) };
    },
    async weeklyReports() {
      await wait();
      needUser();
      return (load().weeklyReports || []).filter((r) => r.user_id === user.id);
    },
    async auditLog() {
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      return db.audit || [];
    },
    async importGuest({ reactions, follows }) {
      needUser(); await wait();
      const db = load();
      const role = profileOf(db, user.id).role;
      for (const r of reactions) if (!db.reactions.some((x) => x.user_id === user.id && x.artwork_id === r.artwork_id)) db.reactions.push({ ...r, user_id: user.id, role, at: tick() });
      for (const f of follows) if (!db.follows.some((x) => x.user_id === user.id && x.artist_id === f.artist_id)) db.follows.push({ ...f, user_id: user.id, role });
      save(db);
    },
  };
};
