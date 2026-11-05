// In-browser stand-in for the Supabase backend, used by the end-to-end test.
// Same methods as src/ui/cloud.js; enforces the same rules as the SQL migration
// (server-stamped roles, critic-only reviews, admin-only Critic/Collector, Elo maths).
// Data lives in localStorage under "mockcloud" so it survives reloads and is shared by tabs.
window.__abremiCloud = async () => {
  const { buildSeedWorld } = await import('/src/core/seed.js');
  const { battleResult, expectedScore } = await import('/src/core/elo.js');
  const { memberBoards } = await import('/src/core/leaderboards.js');
  const { battleStreak, seasonWindow } = await import('/src/core/streak.js');
  const { PLANS } = await import('/src/core/plans.js');
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
  const needAdmin = (db) => { if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only'); };
  // Plans (0012): the plan in force, from the server-side subscription only.
  const planOf = (db, uid) => {
    const s = (db.subs || {})[uid];
    const live = s && ['active', 'trialing', 'past_due'].includes(s.status) && (!s.ends_at || Date.parse(s.ends_at) > Date.now());
    return PLANS.find((p) => p.code === (live ? s.plan : 'free'));
  };
  const validInvite = (db, code) => (db.invites || []).find((i) => i.code === String(code || '').trim().toUpperCase() && !i.revoked && i.uses < i.max_uses);
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
  // Drops (0010): announced once released, to followers and subscribers.
  const dropView = (db, d) => ({ id: d.id, title: d.title, description: d.description, release_at: d.release_at, artist_id: d.artist_id,
    artist_name: profileOf(db, d.owner).name, phase: d.cancelled ? 'cancelled' : Date.parse(d.release_at) > Date.now() ? 'upcoming' : 'released',
    teaser_thumb: (Date.parse(d.release_at) <= Date.now() || d.owner === user?.id) ? db.uploads.find((u) => u.id === d.teaser)?.thumb_path || null : null,
    teaser_palette: d.palette || null, works: db.uploads.filter((u) => u.drop_id === d.id).length,
    subscribed: (db.dropSubs || []).some((x) => x.drop === d.id && x.user === user?.id), mine: d.owner === user?.id });
  const releaseDue = (db) => {
    let changed = false;
    for (const d of db.drops || []) {
      if (d.released || d.cancelled || Date.parse(d.release_at) > Date.now()) continue;
      d.released = true; changed = true;
      const who = new Set([...countedFollows(db).filter((f) => f.artist_id === d.artist_id).map((f) => f.user_id), ...(db.dropSubs || []).filter((x) => x.drop === d.id).map((x) => x.user)]);
      who.delete(d.owner);
      for (const u of who) (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: u, kind: 'drop_released', title: `${profileOf(db, d.owner).name}’s drop “${d.title}” is live`, link: `drop/${d.id}`, created_at: new Date().toISOString(), read_at: null });
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
    uploads: db.uploads.filter((u) => !u.release_at || Date.parse(u.release_at) <= Date.now()).reverse().map(({ owner, image_type, image_bytes, ...u }) => u),
  });

  const api = {
    kind: 'mock',
    async init() { await wait(); return user; },
    onAuth(cb) { listener = cb; },
    async sendLink(email, invite = '') {
      await wait();
      const db = load();
      const isNew = !db.profiles[`u-${email}`];
      if (isNew && db.settings?.invite_required && !validInvite(db, invite)) throw new Error('Abremi is invite-only right now. Enter a valid invite code to join.');
      window.__lastEmail = email;
      window.__lastInvite = invite;
    },
    async verifyCode(email, code) {
      await wait();
      if (code !== '123456') throw new Error('Token has expired or is invalid');
      user = { id: `u-${email}`, email };
      localStorage.setItem(SESSION, JSON.stringify(user));
      const db = load();
      if (!db.profiles[user.id] && db.settings?.invite_required) {
        const inv = validInvite(db, window.__lastInvite);
        if (!inv) { user = null; localStorage.removeItem(SESSION); throw new Error('Abremi is invite-only right now. Enter a valid invite code to join.'); }
        inv.uses++;
      }
      profileOf(db, user.id); save(db);
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
    async leaderboards(country = null, { season = null, medium = null } = {}) {
      await wait();
      const db = load();
      const mediumOf = (id) => db.uploads.find((u) => u.id === id)?.category || seed.artworks.find((w) => w.id === id)?.category || null;
      return memberBoards({
        profiles: Object.values(db.profiles).map((p) => ({ id: p.id, name: p.name, country: p.country, role: p.role, public: p.public_leaderboards !== false })),
        reactions: db.reactions.map((r) => ({ user: r.user_id, artwork: r.artwork_id, kind: r.kind, role: r.role, at: r.at || 0, time: r.time ?? Date.now(), medium: mediumOf(r.artwork_id) })),
        reviews: db.reviews.map((r) => ({ user: r.user_id, rating: r.rating, time: Date.parse(r.created_at) || Date.now(), medium: mediumOf(r.artwork_id) })),
      }, { me: user?.id || null, country, season: season ? seasonWindow(`${season}T00:00:00Z`) : null, medium: medium || null });
    },
    async myBattleStreak() {
      await wait();
      if (!user) return null;
      return battleStreak(load().votes.filter((v) => v.user_id === user.id).map((v) => v.time || Date.now()));
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
        if (kind) db.reactions.push({ user_id: user.id, artwork_id, kind, role: profileOf(db, user.id).role, at: tick(), time: Date.now() });
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
      db.votes.push({ user_id: user.id, w, l, role, time: Date.now() });
      const best = battleStreak(db.votes.filter((v) => v.user_id === user.id).map((v) => v.time || Date.now())).best;
      for (const n of [7, 30, 100]) if (best >= n) award(db, user.id, `streak_${n}`, { days: best });
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
      const avail = (a) => ['available', 'on_request'].includes(a || 'available');
      const becameAvailable = avail(availability) && !avail(w.availability);
      const newPrice = price !== w.price && avail(availability);
      Object.assign(w, { title: title.trim(), category, style, medium, year, price, description: description.trim() || null, dimensions: dimensions.trim() || null, availability });
      if (becameAvailable || newPrice) { // 0015: tell treasurers and the waitlist
        const to = new Set([...db.reactions.filter((r) => r.artwork_id === id && r.kind === 'super').map((r) => r.user_id), ...(db.watches || []).filter((x) => x.artwork === id).map((x) => x.user)]);
        to.delete(w.owner);
        for (const u of to) (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: u, kind: 'artwork_alert', title: becameAvailable ? `“${w.title}” is now available` : `“${w.title}” has a new price`, link: `art/${id}`, created_at: new Date().toISOString(), read_at: null });
      }
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
        { code: 'streak_7', audience: 'member', label: 'Art Battle Streak · 7 days', criteria: 'Voted in the Art Battle 7 days running (one missed day a week is forgiven).', sort: 70 },
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
      days = [7, 30, 90, 365].includes(days) ? days : 30;
      if (days > planOf(db, user.id).analytics_days) throw new Error('A year of analytics comes with Artist Pro and Elite');
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
      return { artist, days, max_days: planOf(db, user.id).analytics_days, current: summary(from, end), previous: summary(prev, from), followers_total: fol.length, daily, works, roles,
        countries: Object.entries(grouped).map(([country, n]) => ({ country, people: n })).sort((a, b) => b.people - a.people) };
    },
    async weeklyReports() {
      await wait();
      needUser();
      return (load().weeklyReports || []).filter((r) => r.user_id === user.id);
    },
    // ——— Phase 4 (same rules as supabase/migrations/0010_radar_drops.sql) ———
    async sendInquiry({ artworkId = null, artistId = null, kind, message = '' }) {
      needUser(); await wait();
      const db = load();
      if (Date.parse(profileOf(db, user.id).created_at) > Date.now() - 3 * 86400e3) throw new Error('New accounts can send inquiries after 3 days');
      const w = artworkId ? db.uploads.find((u) => u.id === artworkId) : null;
      if (artworkId && !w && !catalogArtist[artworkId]) throw new Error('Artwork not found');
      const aid = w ? w.artist_id : artworkId ? catalogArtist[artworkId] : artistId;
      const owner = aid?.startsWith('m_') ? aid.slice(2) : null;
      if (!owner) throw new Error('Sample artists can’t be contacted');
      if (owner === user.id) throw new Error('That’s your own work');
      if (kind === 'purchase' && !w) throw new Error('Choose a work to ask about buying it');
      if (kind === 'purchase' && !['available', 'on_request', undefined, null].includes(w.availability)) throw new Error('This work isn’t available');
      db.inquiries ||= []; db.blocks ||= [];
      if (db.blocks.some((b) => (b.user === user.id && b.blocked === owner) || (b.user === owner && b.blocked === user.id))) throw new Error('You can’t contact this member');
      if (db.inquiries.some((q) => q.sender === user.id && q.artist_id === aid && q.status === 'open' && q.artwork === (w?.id || null))) throw new Error('You already have an open conversation about this');
      if (message.trim().length < 10) throw new Error('Write a little more (at least 10 characters)');
      const q = { id: crypto.randomUUID(), artwork: w?.id || null, artist_id: aid, artist_user: owner, sender: user.id, kind, status: 'open', artist_unread: true, sender_unread: false,
        messages: [{ from: user.id, body: message.trim(), at: new Date().toISOString() }], last: Date.now() };
      db.inquiries.push(q);
      (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: owner, kind: 'inquiry', title: `${profileOf(db, user.id).name} sent you ${kind === 'purchase' ? 'a purchase inquiry' : kind === 'commission' ? 'a commission request' : kind === 'sponsorship' ? 'a sponsorship request' : 'a question'}${w ? ` about “${w.title}”` : ''}`, link: `inquiry/${q.id}`, created_at: new Date().toISOString(), read_at: null });
      save(db);
      return q.id;
    },
    async inquiries() {
      await wait();
      if (!user) return [];
      const db = load();
      return (db.inquiries || []).filter((q) => [q.artist_user, q.sender].includes(user.id)).sort((a, b) => b.last - a.last).map((q) => {
        const artistSide = q.artist_user === user.id;
        const other = profileOf(db, artistSide ? q.sender : q.artist_user);
        return { id: q.id, kind: q.kind, status: q.status, artwork: q.artwork, artist: q.artist_id, side: artistSide ? 'artist' : 'sender', other_name: other.name, other_role: other.role,
          unread: artistSide ? q.artist_unread : q.sender_unread, last_message: q.messages.at(-1).body.slice(0, 140), last_message_at: new Date(q.last).toISOString() };
      });
    },
    async inquiryThread(id) {
      await wait();
      const db = load();
      const q = (db.inquiries || []).find((x) => x.id === id && [x.artist_user, x.sender].includes(user?.id));
      if (!q) return null;
      const artistSide = q.artist_user === user.id;
      const otherId = artistSide ? q.sender : q.artist_user;
      const other = profileOf(db, otherId);
      return { id: q.id, kind: q.kind, status: q.status, artwork: q.artwork, artist: q.artist_id, side: artistSide ? 'artist' : 'sender', other_name: other.name, other_role: other.role,
        blocked: (db.blocks || []).some((b) => b.user === user.id && b.blocked === otherId), messages: q.messages.map((m) => ({ mine: m.from === user.id, body: m.body, at: m.at })) };
    },
    async replyInquiry(id, body) {
      needUser(); await wait();
      const db = load();
      const q = (db.inquiries || []).find((x) => x.id === id && [x.artist_user, x.sender].includes(user.id));
      if (!q) throw new Error('Conversation not found');
      if (q.status !== 'open') throw new Error('This conversation is closed');
      const artistSide = q.artist_user === user.id;
      const other = artistSide ? q.sender : q.artist_user;
      if (!body.trim()) throw new Error('violates check constraint');
      q.messages.push({ from: user.id, body: body.trim(), at: new Date().toISOString() });
      if (!(artistSide ? q.sender_unread : q.artist_unread)) (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: other, kind: 'inquiry_reply', title: `${profileOf(db, user.id).name} replied to your conversation`, link: `inquiry/${q.id}`, created_at: new Date().toISOString(), read_at: null });
      if (artistSide) q.sender_unread = true; else q.artist_unread = true;
      q.last = Date.now();
      save(db);
    },
    async setInquiryStatus(id, status) {
      needUser(); await wait();
      const db = load();
      const q = (db.inquiries || []).find((x) => x.id === id && [x.artist_user, x.sender].includes(user.id));
      if (!q) throw new Error('Conversation not found');
      if (status === 'declined' && q.artist_user !== user.id) throw new Error('Only the artist can decline; either of you can close');
      q.status = status;
      save(db);
    },
    async markInquiryRead(id) {
      const db = load();
      const q = (db.inquiries || []).find((x) => x.id === id);
      if (!q || ![q.artist_user, q.sender].includes(user?.id)) return;
      const key = q.artist_user === user.id ? 'artist_unread' : 'sender_unread';
      if (q[key]) { q[key] = false; save(db); }
    },
    async setBlock(id, on) {
      needUser(); await wait();
      const db = load();
      const q = (db.inquiries || []).find((x) => x.id === id && [x.artist_user, x.sender].includes(user.id));
      if (!q) throw new Error('Conversation not found');
      const other = q.artist_user === user.id ? q.sender : q.artist_user;
      db.blocks = (db.blocks || []).filter((b) => !(b.user === user.id && b.blocked === other));
      if (on) {
        db.blocks.push({ user: user.id, blocked: other });
        for (const x of db.inquiries) if (x.status === 'open' && [x.artist_user, x.sender].includes(other) && [x.artist_user, x.sender].includes(user.id)) x.status = 'closed';
      }
      save(db);
    },
    async reportInquiry(id, reason) {
      needUser(); await wait();
      const db = load();
      (db.inquiryReports ||= []).push({ id: crypto.randomUUID(), inquiry: id, reporter: user.id, reason, status: 'open', created_at: new Date().toISOString() });
      save(db);
    },
    async inquiryReports() { return []; },
    async collectorInterest() {
      await wait();
      const db = load();
      return db.uploads.filter((u) => u.owner === user?.id).map((u) => ({ artwork: u.id,
        inquiries: (db.inquiries || []).filter((q) => q.artwork === u.id).length,
        open_inquiries: (db.inquiries || []).filter((q) => q.artwork === u.id && q.status === 'open').length,
        collector_saves: counted(db).filter((r) => r.artwork_id === u.id && r.kind === 'super' && r.role === 'collector').length }));
    },
    async drops() {
      await wait();
      const db = load();
      releaseDue(db);
      return (db.drops || []).filter((d) => !d.cancelled).map((d) => dropView(db, d)).sort((a, b) => (a.phase === 'upcoming' ? 0 : 1) - (b.phase === 'upcoming' ? 0 : 1) || Date.parse(a.release_at) - Date.parse(b.release_at));
    },
    async drop(id) {
      await wait();
      const db = load();
      releaseDue(db);
      const d = (db.drops || []).find((x) => x.id === id);
      if (!d) return null;
      const v = dropView(db, d);
      const ids = db.uploads.filter((u) => u.drop_id === id).map((u) => u.id);
      return { ...v, work_count: ids.length, works: v.phase !== 'upcoming' || v.mine ? ids : [] };
    },
    async createDrop({ title, description = '', releaseAt, artworkIds, palette = null }) {
      needUser(); await wait();
      const db = load();
      const t = Date.parse(releaseAt);
      if (!(t >= Date.now() + 10 * 60e3 && t <= Date.now() + 60 * 86400e3)) throw new Error('Release between 10 minutes and 60 days from now');
      if (!artworkIds.length || artworkIds.length > 12) throw new Error('A drop has 1 to 12 works');
      const works = db.uploads.filter((u) => artworkIds.includes(u.id) && u.owner === user.id);
      if (works.length !== artworkIds.length) throw new Error('A drop can include only your own works that aren’t in another upcoming drop');
      db.drops ||= [];
      const maxUpcoming = planOf(db, user.id).max_upcoming_drops;
      if (db.drops.filter((d) => d.owner === user.id && !d.released && !d.cancelled).length >= maxUpcoming) throw new Error(`Your plan allows ${maxUpcoming} upcoming drop${maxUpcoming === 1 ? '' : 's'} at a time`);
      const d = { id: crypto.randomUUID(), owner: user.id, artist_id: `m_${user.id}`, title: title.trim(), description, release_at: new Date(t).toISOString(), teaser: artworkIds[0], palette: /^(#[0-9a-f]{6},){8}#[0-9a-f]{6}$/.test(palette || '') ? palette : null };
      db.drops.push(d);
      for (const w of works) Object.assign(w, { drop_id: d.id, release_at: d.release_at });
      for (const f of countedFollows(db).filter((x) => x.artist_id === d.artist_id)) (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: f.user_id, kind: 'drop_announced', title: `${profileOf(db, user.id).name} announced a drop: “${d.title}”`, link: `drop/${d.id}`, created_at: new Date().toISOString(), read_at: null });
      save(db);
      return d.id;
    },
    async cancelDrop(id) {
      needUser(); await wait();
      const db = load();
      const d = (db.drops || []).find((x) => x.id === id && !x.released && !x.cancelled);
      if (!d) throw new Error('That drop has already been released or cancelled');
      if (d.owner !== user.id && !(db.admins || []).includes(user.id)) throw new Error('Only the artist or a moderator can cancel a drop');
      d.cancelled = true;
      for (const w of db.uploads) if (w.drop_id === id) w.release_at = null;
      save(db);
    },
    async subscribeDrop(id, on) {
      needUser(); await wait();
      const db = load();
      db.dropSubs = (db.dropSubs || []).filter((x) => !(x.drop === id && x.user === user.id));
      if (on) db.dropSubs.push({ drop: id, user: user.id });
      save(db);
    },
    async scheduledWorks() {
      await wait();
      const db = load();
      return db.uploads.filter((u) => u.owner === user?.id && u.release_at && Date.parse(u.release_at) > Date.now())
        .map((u) => ({ id: u.id, title: u.title, drop_id: u.drop_id, release_at: u.release_at, thumb_path: u.thumb_path, image_path: u.image_path }));
    },
    // ——— Phase 5 (same rules as 0011; the Coach's model call is stood in by a canned draft) ———
    async coachUsage() {
      const db = load();
      const month = new Date().toISOString().slice(0, 7);
      const plan = planOf(db, user?.id);
      return { used: (db.coach || []).filter((c) => c.user === user?.id && c.ok && c.month === month).length, limit: plan.coach_monthly, plan: plan.name };
    },
    async coach(tool, { artworkId = null, opportunityId = null } = {}) {
      needUser(); await wait();
      const db = load();
      if (!db.artists[`m_${user.id}`]) throw new Error('The Coach is for artists: publish a work first');
      const usage = await this.coachUsage();
      if (usage.limit === 0) throw new Error('The Career Coach comes with Artist Pro and Elite');
      if (usage.used >= usage.limit) throw new Error(`You’ve used this month’s ${usage.limit} Coach requests. They reset on the 1st.`);
      const w = artworkId ? db.uploads.find((u) => u.id === artworkId && u.owner === user.id) : null;
      if (['description', 'social'].includes(tool) && !w) throw new Error('Choose one of your own works');
      const o = opportunityId ? (db.opportunities || []).find((x) => x.id === opportunityId && x.status === 'approved') : null;
      if (tool === 'application' && !o) throw new Error('Choose a listed opportunity');
      (db.coach ||= []).push({ user: user.id, tool, ok: true, month: new Date().toISOString().slice(0, 7) });
      save(db);
      const works = db.uploads.filter((u) => u.owner === user.id).length;
      return { tool, text: `[Stand-in draft for ${tool}]${w ? ` about “${w.title}”` : ''}${o ? ` for “${o.title}”` : ''}.\nWritten only from your profile and works. [add: where you studied]`,
        basedOn: ['your profile', `${works} of your works`, ...(w ? [`“${w.title}”`] : []), ...(o ? [`the listing “${o.title}”`] : [])] };
    },
    async passport(artistId) {
      await wait();
      const db = load();
      const owner = artistId.startsWith('m_') ? artistId.slice(2) : null;
      if (!owner || !db.artists[artistId]) return null;
      const defs = await this.achievementDefinitions();
      return {
        achievements: Object.values((db.achievements || {})[owner] || {}).map((m) => ({ ...defs.find((d) => d.code === m.code), at: m.awarded_at })).filter((a) => a.audience === 'artist'),
        competitions: (db.competitions || []).filter((c) => c.results).flatMap((c) => c.results.entries.filter((r) => (db.entries || []).find((e) => e.id === r.entry)?.user_id === owner)
          .map((r) => ({ id: c.id, title: c.title, kind: c.kind, closed_at: c.closed_at, place: r.place, votes: r.votes, artwork: r.artwork }))),
        exhibitions: (db.exhibitions || []).filter((e) => e.owner === owner && e.status === 'verified'),
        milestones: { joined: db.artists[artistId].created_at, first_work: db.uploads.filter((u) => u.owner === owner).map((u) => u.created_at).sort()[0] || null, first_drop: null, first_inquiry: null },
      };
    },
    async myExhibitions() {
      await wait();
      return (load().exhibitions || []).filter((e) => e.owner === user?.id);
    },
    async submitExhibition({ kind, title, venue, city, start, end, link }) {
      needUser(); await wait();
      const db = load();
      if (!db.artists[`m_${user.id}`]) throw new Error('Publish a work first');
      if (!/^https:\/\/[^\s<>"]+$/.test(link || '')) throw new Error('violates check constraint "exhibitions_link_check"');
      const e = { id: crypto.randomUUID(), owner: user.id, artist_id: `m_${user.id}`, kind, title, venue, city, start_date: start, end_date: end || null, link, status: 'pending', created_at: new Date().toISOString() };
      (db.exhibitions ||= []).push(e);
      save(db);
      return e.id;
    },
    async deleteExhibition(id) {
      const db = load();
      db.exhibitions = (db.exhibitions || []).filter((e) => !(e.id === id && e.owner === user?.id));
      save(db);
    },
    async exhibitionQueue() {
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      return (db.exhibitions || []).filter((e) => e.status === 'pending').map((e) => ({ ...e, artist: profileOf(db, e.owner).name, priority: planOf(db, e.owner).priority_review }))
        .sort((a, b) => Number(b.priority) - Number(a.priority));
    },
    async reviewExhibition(id, verify, note) {
      await wait();
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      const e = (db.exhibitions || []).find((x) => x.id === id && x.status === 'pending');
      if (!e) throw new Error('That exhibition is no longer pending');
      Object.assign(e, { status: verify ? 'verified' : 'rejected', review_note: note || null });
      (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: e.owner, kind: 'exhibition_review', title: verify ? `“${e.title}” is verified on your Passport` : `“${e.title}” couldn’t be verified`, link: `artist/${e.artist_id}`, created_at: new Date().toISOString(), read_at: null });
      save(db);
    },
    async opportunities() {
      await wait();
      const db = load();
      const today = new Date().toISOString().slice(0, 10);
      return (db.opportunities || []).filter((o) => o.status === 'approved' && o.deadline >= today).sort((a, b) => a.deadline.localeCompare(b.deadline))
        .map((o) => ({ ...o, gallery_id: (db.galleries || []).some((g) => g.id === o.gallery_id && g.status === 'verified') ? o.gallery_id : null, saved: (db.savedOpps || []).some((x) => x.opp === o.id && x.user === user?.id) }));
    },
    async suggestOpportunity(o) {
      needUser(); await wait();
      const db = load();
      const admin = (db.admins || []).includes(user.id);
      const gal = (db.galleries || []).find((g) => g.owner === user.id && g.status === 'verified');
      const direct = admin || Boolean(gal && planOf(db, user.id).direct_opportunities);
      if (!admin && !gal && Date.parse(profileOf(db, user.id).created_at) > Date.now() - 3 * 86400e3) throw new Error('New accounts can suggest opportunities after 3 days');
      if (!/^https:\/\/[^\s<>"]+$/.test(o.link || '')) throw new Error('violates check constraint "opportunities_link_check"');
      if (o.deadline < new Date().toISOString().slice(0, 10)) throw new Error('The deadline has passed');
      const row = { id: crypto.randomUUID(), kind: o.kind, title: o.title, organizer: o.organizer, location: o.location, deadline: o.deadline, eligibility: o.eligibility || '',
        description: o.description || '', fee: Number(o.fee) || 0, fee_currency: o.currency || 'USD', link: o.link, status: direct ? 'approved' : 'pending', submitted_by: user.id,
        ...(gal ? { organizer: gal.name, gallery_id: gal.id } : {}) };
      (db.opportunities ||= []).push(row);
      save(db);
      return row.id;
    },
    async saveOpportunity(id, on) {
      needUser(); await wait();
      const db = load();
      db.savedOpps = (db.savedOpps || []).filter((x) => !(x.opp === id && x.user === user.id));
      if (on) db.savedOpps.push({ opp: id, user: user.id });
      save(db);
    },
    async opportunityQueue() {
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      return (db.opportunities || []).filter((o) => o.status === 'pending');
    },
    async reviewOpportunity(id, approve) {
      await wait();
      const db = load();
      if (!(db.admins || []).includes(user?.id)) throw new Error('Admins only');
      const o = (db.opportunities || []).find((x) => x.id === id && x.status === 'pending');
      if (!o) throw new Error('That listing is no longer pending');
      o.status = approve ? 'approved' : 'rejected';
      save(db);
    },
    // ——— Phase 6 (same rules as 0012) ———
    async appFlags() {
      const db = load();
      return { invite_required: Boolean(db.settings?.invite_required), payments_enabled: false, sales_enabled: Boolean(db.settings?.sales_enabled) };
    },
    async myPlan() {
      if (!user) return null;
      const db = load();
      const plan = planOf(db, user.id);
      const s = (db.subs || {})[user.id];
      return { plan, status: plan.code === 'free' ? null : s.status, source: plan.code === 'free' ? null : s.source, ends_at: plan.code === 'free' ? null : s.ends_at, manage: false,
        show_badge: profileOf(db, user.id).show_plan_badge !== false };
    },
    async setPlanBadge(show) {
      needUser();
      const db = load();
      profileOf(db, user.id).show_plan_badge = show;
      save(db);
    },
    async planBadges() {
      const db = load();
      return Object.fromEntries(Object.keys(db.subs || {}).filter((uid) => profileOf(db, uid).show_plan_badge !== false)
        .map((uid) => [`m_${uid}`, planOf(db, uid).badge]).filter(([a, b]) => b && db.artists[a]));
    },
    async billing() { await wait(); throw new Error('Payments aren’t switched on yet.'); },
    async myGallery() {
      return user ? (load().galleries || []).find((g) => g.owner === user.id) || null : null;
    },
    async applyGallery({ name, city, country, website, bio }) {
      needUser(); await wait();
      const db = load();
      if (Date.parse(profileOf(db, user.id).created_at) > Date.now() - 3 * 86400e3) throw new Error('New accounts can apply for a gallery account after 3 days');
      if (!/^https:\/\/[^\s<>"]+$/.test(website || '')) throw new Error('violates check constraint "galleries_website_check"');
      db.galleries ||= [];
      let g = db.galleries.find((x) => x.owner === user.id);
      if (!g) { g = { id: crypto.randomUUID(), owner: user.id, status: 'pending', created_at: new Date().toISOString() }; db.galleries.push(g); }
      const keep = g.status === 'verified' && g.name === name.trim();
      Object.assign(g, { name: name.trim(), city: city.trim(), country: country.trim().toUpperCase(), website: website.trim(), bio: (bio || '').trim(), status: keep ? 'verified' : 'pending' });
      save(db);
      return g.id;
    },
    async galleryPage(id) {
      await wait();
      const db = load();
      const g = (db.galleries || []).find((x) => x.id === id && x.status === 'verified');
      if (!g) return null;
      const today = new Date().toISOString().slice(0, 10);
      return { ...g, opportunities: (db.opportunities || []).filter((o) => o.gallery_id === g.id && o.status === 'approved' && o.deadline >= today) };
    },
    async galleryQueue() {
      const db = load(); needAdmin(db);
      return (db.galleries || []).filter((g) => g.status === 'pending').map((g) => ({ ...g, member: profileOf(db, g.owner).name }));
    },
    async reviewGallery(id, verify, note) {
      await wait();
      const db = load(); needAdmin(db);
      const g = (db.galleries || []).find((x) => x.id === id && x.status === 'pending');
      if (!g) throw new Error('That gallery is no longer pending');
      Object.assign(g, { status: verify ? 'verified' : 'rejected', review_note: note || null });
      (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: g.owner, kind: 'gallery_review', title: verify ? `${g.name} is now a verified gallery on Abremi` : `${g.name} couldn’t be verified`, link: verify ? `gallery/${g.id}` : 'profile', created_at: new Date().toISOString(), read_at: null });
      save(db);
    },
    async findMembers(q) {
      const db = load(); needAdmin(db);
      q = String(q || '').trim().toLowerCase();
      if (q.length < 2) return [];
      return Object.values(db.profiles).filter((p) => p.name.toLowerCase().includes(q) || (db.artists[`m_${p.id}`]?.name || '').toLowerCase().includes(q))
        .map((p) => ({ id: p.id, name: p.name, country: p.country, role: p.role, artist_id: db.artists[`m_${p.id}`] ? `m_${p.id}` : null, plan: planOf(db, p.id).code,
          verified_gallery: (db.galleries || []).some((g) => g.owner === p.id && g.status === 'verified') }));
    },
    async grantPlan(uid, plan, until, note) {
      await wait();
      const db = load(); needAdmin(db);
      if (!['pro', 'elite', 'gallery'].includes(plan)) throw new Error('Choose Pro, Elite or Gallery');
      const today = new Date().toISOString().slice(0, 10);
      if (!until || until <= today || Date.parse(until) > Date.now() + 366 * 864e5) throw new Error('A grant ends between tomorrow and a year from now');
      if (plan === 'gallery' && !(db.galleries || []).some((g) => g.owner === uid && g.status === 'verified')) throw new Error('The Gallery plan is for verified galleries');
      (db.subs ||= {})[uid] = { plan, status: 'active', source: 'grant', ends_at: new Date(Date.parse(until) + 864e5).toISOString(), note: note || null };
      const name = PLANS.find((p) => p.code === plan).name;
      (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: uid, kind: 'plan_granted', title: `You have ${name} until ${new Date(until).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`, link: 'plans', created_at: new Date().toISOString(), read_at: null });
      save(db);
    },
    async revokePlan(uid) {
      const db = load(); needAdmin(db);
      if ((db.subs || {})[uid]?.source !== 'grant') throw new Error('No granted plan to remove');
      delete db.subs[uid];
      save(db);
    },
    async planHolders() {
      const db = load(); needAdmin(db);
      return Object.entries(db.subs || {}).filter(([, s]) => Date.parse(s.ends_at) > Date.now())
        .map(([uid, s]) => ({ user_id: uid, name: profileOf(db, uid).name, plan: s.plan, status: s.status, source: s.source, ends_at: s.ends_at, note: s.note }));
    },
    async checkInvite(code) { return Boolean(validInvite(load(), code)); },
    async createInvite(maxUses, days, note) {
      const db = load(); needAdmin(db);
      const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => A[b % 31]).join('');
      (db.invites ||= []).unshift({ code, max_uses: maxUses, uses: 0, expires_at: days ? new Date(Date.now() + days * 864e5).toISOString() : null, note: note || null, revoked: false, created_at: new Date().toISOString() });
      save(db);
      return code;
    },
    async invites() {
      const db = load(); needAdmin(db);
      return { invite_required: Boolean(db.settings?.invite_required), codes: db.invites || [] };
    },
    async revokeInvite(code) {
      const db = load(); needAdmin(db);
      const i = (db.invites || []).find((x) => x.code === code);
      if (i) i.revoked = true;
      save(db);
    },
    async setInviteRequired(on) {
      const db = load(); needAdmin(db);
      (db.settings ||= {}).invite_required = on;
      save(db);
    },
    async submitFeedback(kind, message, page) {
      needUser(); await wait();
      if (String(message).trim().length < 5) throw new Error('violates check constraint "feedback_message_check"');
      const db = load();
      (db.feedback ||= []).push({ id: crypto.randomUUID(), user: user.id, kind, message: message.trim(), page, status: 'open', created_at: new Date().toISOString() });
      save(db);
    },
    async feedbackQueue(status = 'open') {
      const db = load(); needAdmin(db);
      return (db.feedback || []).filter((f) => f.status === status).map((f) => ({ ...f, member: profileOf(db, f.user).name })).reverse();
    },
    async resolveFeedback(id, note) {
      const db = load(); needAdmin(db);
      const f = (db.feedback || []).find((x) => x.id === id && x.status === 'open');
      if (!f) throw new Error('That note is already resolved');
      Object.assign(f, { status: 'resolved', note: note || null });
      save(db);
    },
    async logError({ message, source, page, release }) {
      const db = load();
      (db.clientErrors ||= []).push({ message: String(message).slice(0, 500), source, page: String(page || '').replace(/[?].*$/, ''), release, at: new Date().toISOString() });
      save(db);
    },
    async clientErrors() {
      const db = load(); needAdmin(db);
      const groups = {};
      for (const e of db.clientErrors || []) {
        const g = (groups[`${e.message}|${e.source}`] ||= { message: e.message, source: e.source, count: 0, last_seen: e.at, pages: [] });
        g.count++; g.last_seen = e.at; if (e.page && !g.pages.includes(e.page)) g.pages.push(e.page);
      }
      return Object.values(groups);
    },
    // ——— Phase 7 (same rules as 0013; the model is stood in by a canned reply that goes through the
    // real suggestion and reference-filter code in api/_guide.js) ———
    async guide({ mode, messages, page }, onEvent) {
      needUser(); await wait();
      const db = load();
      const uid = user.id;
      const prof = profileOf(db, uid);
      if (!['visitor', 'artist', 'collector'].includes(mode)) throw new Error('Choose a mode');
      if (mode === 'artist' && !db.artists[`m_${uid}`]) throw new Error('The artist mode is for artists: publish a work first');
      const today = new Date().toISOString().slice(0, 10);
      const limit = planOf(db, uid).assistant_daily;
      const used = (db.guide || []).filter((r) => r.user === uid && r.ok && r.day === today).length;
      if (used >= limit) throw new Error(`You’ve used today’s ${limit} messages. They reset at midnight UTC.`);
      if (window.__guideFail) { const f = window.__guideFail; window.__guideFail = null; onEvent({ type: 'error', error: f, retry: true }); return; }
      const g = await import('/api/_guide.js');
      const catalog = g.enrichCatalog({
        artworks: [...seed.artworks.map((w) => ({ id: w.id, title: w.title, artist_id: w.artistId, sample: true, popularity: 0, trending: 0 })),
          ...db.uploads.filter((u) => !u.hidden && !(u.release_at && Date.parse(u.release_at) > Date.now())).map((u) => ({ id: u.id, title: u.title, artist_id: u.artist_id, sample: false, category: u.category, style: u.style, medium: u.medium, popularity: 0, trending: 0 }))],
        artists: [...seed.artists.map((a) => ({ id: a.id, name: a.name, country: a.country, sample: true, followers: 0 })),
          ...Object.values(db.artists).map((a) => ({ id: a.id, name: a.name, country: a.country, sample: false, followers: 0 }))],
      });
      const personal = prof.assistant_personalize === false ? {} : {
        interests: prof.assistant_interests || '',
        follows: db.follows.filter((f) => f.user_id === uid).map((f) => f.artist_id),
        saved: db.reactions.filter((r) => r.user_id === uid && r.kind === 'super').map((r) => r.artwork_id),
      };
      const pageCtx = page?.type === 'artwork' ? { type: 'artwork', artwork: { id: page.id } } : page;
      const picks = g.selectCandidates({ catalog, page: pageCtx, personal, messages, mode });
      const w = picks.artworks[0], a = picks.artists[0];
      const reply = `[Stand-in reply for ${mode}]${page?.type ? ` about this ${page.type}` : ''}: ${messages.at(-1).content}\n`
        + `[[art:${w.id}]] — ${w.why}\n[[art:w99999]] — an invented work\n[[artist:${a.id}]] — ${a.you_follow ? 'you follow them' : 'worth following'}\n[[search:${w.style || 'Abstract'}]] — more in this style\n`;
      const filter = g.referenceFilter({ artworkIds: new Set(catalog.artworks.map((x) => x.id)), artistIds: new Set(catalog.artists.map((x) => x.id)) });
      for (const piece of reply.match(/[\s\S]{1,24}/g)) {
        await new Promise((r) => setTimeout(r, 15));
        const safe = filter.push(piece);
        if (safe) onEvent({ type: 'text', text: safe });
      }
      const rest = filter.end();
      if (rest) onEvent({ type: 'text', text: rest });
      (db.guide ||= []).push({ user: uid, mode, ok: true, day: today, at: new Date().toISOString() });
      save(db);
      onEvent({ type: 'done', usage: { used: used + 1, limit }, refs: filter.refs });
    },
    async guideUsage() {
      if (!user) return null;
      const db = load();
      const today = new Date().toISOString().slice(0, 10);
      return { used: (db.guide || []).filter((r) => r.user === user.id && r.ok && r.day === today).length, limit: planOf(db, user.id).assistant_daily };
    },
    async guidePrefs() {
      if (!user) return null;
      const p = profileOf(load(), user.id);
      return { personalize: p.assistant_personalize !== false, interests: p.assistant_interests || '' };
    },
    async setGuidePrefs(personalize, interests) {
      needUser();
      const db = load();
      Object.assign(profileOf(db, user.id), { assistant_personalize: personalize, assistant_interests: String(interests || '').slice(0, 300) });
      save(db);
    },
    async resetGuide() {
      needUser();
      const db = load();
      Object.assign(profileOf(db, user.id), { assistant_personalize: true, assistant_interests: '' });
      db.guideEvents = (db.guideEvents || []).filter((e) => e.user !== user.id);
      save(db);
    },
    async guideEvent(kind, target) {
      if (!user) return;
      const db = load();
      (db.guideEvents ||= []).push({ user: user.id, kind, target: target || null, at: new Date().toISOString() });
      save(db);
    },
    async guideMetrics() {
      const db = load(); needAdmin(db);
      const reqs = db.guide || [];
      const events = {};
      for (const e of db.guideEvents || []) events[e.kind] = (events[e.kind] || 0) + 1;
      const days = {};
      for (const r of reqs) (days[r.user] ||= new Set()).add(r.day);
      const byMode = {};
      for (const r of reqs) byMode[r.mode] = (byMode[r.mode] || 0) + 1;
      return { days: 30, messages: reqs.filter((r) => r.ok).length, failed: 0, members: Object.keys(days).length,
        returning: Object.values(days).filter((s) => s.size >= 2).length, by_mode: byMode, events };
    },
    // ——— Phase 8 (same rules as 0015) ———
    async sendOffer(artworkId, amount, currency, message) {
      if (!(amount > 0 && amount <= 1e7)) throw new Error('Enter an offer between 1 and 10,000,000');
      if (!/^[A-Za-z]{3}$/.test(currency || '')) throw new Error('Use a three-letter currency code, like USD');
      const id = await this.sendInquiry({ artworkId, kind: 'purchase', message });
      const db = load();
      const q = (db.inquiries || []).find((x) => x.id === id);
      if (q) { q.offer = { amount: Math.round(amount * 100) / 100, currency: currency.toUpperCase() }; save(db); }
      return id;
    },
    async inquiryOffer(id) {
      const q = (load().inquiries || []).find((x) => x.id === id);
      return q && q.offer && [q.sender, q.artist_user].includes(user?.id) ? q.offer : null; // only the two people
    },
    async watchArtwork(id, on) {
      needUser();
      const db = load();
      const w = db.uploads.find((u) => u.id === id);
      if (on && (!w || w.owner === user.id)) throw new Error('You can’t follow this work');
      db.watches = (db.watches || []).filter((x) => !(x.user === user.id && x.artwork === id));
      if (on) db.watches.push({ user: user.id, artwork: id });
      save(db);
    },
    async myWatches() {
      return user ? (load().watches || []).filter((x) => x.user === user.id).map((x) => x.artwork) : [];
    },
    async setInterests({ mediums = [], regions = [], priceMax = null }) {
      needUser();
      if (priceMax != null && !(priceMax >= 1 && priceMax <= 1e7)) throw new Error('Choose a price limit between 1 and 10,000,000');
      const db = load();
      profileOf(db, user.id).discovery_interests = { mediums: mediums.filter((m) => /^[a-z]{2,20}$/.test(m)), regions: [...new Set(regions.map((r) => r.toUpperCase()))].filter((r) => /^[A-Z]{2}$/.test(r)), price_max: priceMax };
      save(db);
    },
    async myInterests() {
      if (!user) return null;
      const p = profileOf(load(), user.id);
      return { interests: p.discovery_interests || {}, personalize: p.assistant_personalize !== false };
    },
    // ——— The Abremi Index (same scoring as 0016, computed live for the latest week) ———
    async indexWeek(week = null, chart = 'overall') {
      await wait();
      const db = load();
      const since = Date.now() - 7 * 864e5;
      const works = {};
      for (const r of counted(db)) {
        const u = db.uploads.find((x) => x.id === r.artwork_id);
        if (!u || u.hidden || r.kind === 'pass' || (r.at && r.at < since)) continue;
        const a = db.artists[u.artist_id];
        (works[u.id] ||= { id: u.id, title: u.title, artist_id: u.artist_id, artist: a?.name, country: a?.country, category: u.category, score: 0 }).score += W[r.role] * (r.kind === 'super' ? 2 : 1);
      }
      const all = Object.values(works);
      const inChart = (w) => chart === 'overall' || chart === `medium:${w.category}` || chart === `country:${w.country}`;
      const rank = (xs) => xs.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 100).map((x, i) => ({ ...x, rank: i + 1 }));
      const artists = {};
      for (const w of all.filter(inChart)) (artists[w.artist_id] ||= { id: w.artist_id, name: w.artist, country: w.country, score: 0 }).score += w.score;
      const monday = new Date(); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const wk = monday.toISOString().slice(0, 10);
      return { week: wk, covers_from: new Date(monday - 7 * 864e5).toISOString().slice(0, 10), chart, weeks: [wk],
        charts: [...new Set(all.flatMap((w) => ['overall', `medium:${w.category}`, `country:${w.country}`]))],
        artworks: rank(all.filter(inChart)), artists: rank(Object.values(artists)) };
    },
    async foundingArtists() {
      await wait();
      const db = load();
      const has = (id) => db.uploads.some((u) => u.artist_id === id && !u.hidden && (!u.release_at || Date.parse(u.release_at) <= Date.now()));
      return (db.founding || []).filter((f) => has(f.artist_id));
    },
    async setFounding(artistId, on) {
      needUser(); await wait();
      const db = load();
      if (!(db.admins || []).includes(user.id)) throw new Error('Admins only');
      if (!artistId.startsWith('m_')) throw new Error('Only member artists can be founding artists');
      db.founding = (db.founding || []).filter((f) => f.artist_id !== artistId);
      if (on) db.founding.push({ artist_id: artistId, since: new Date().toISOString() });
      save(db);
      return on;
    },
    async verifiedArtists() {
      await wait();
      return load().verified || [];
    },
    async setVerified(artistId, on, managed = false) {
      needUser(); await wait();
      const db = load();
      if (!(db.admins || []).includes(user.id)) throw new Error('Admins only');
      if (!artistId.startsWith('m_')) throw new Error('Only member artists can be verified');
      db.verified = (db.verified || []).filter((v) => v.artist_id !== artistId);
      if (on) db.verified.push({ artist_id: artistId, managed: Boolean(managed), since: new Date().toISOString() });
      save(db);
      return on;
    },
    async verifyCertificate(code) {
      await wait();
      const db = load();
      const o = (db.orders || []).find((x) => x.certificate === String(code || '').trim().toUpperCase());
      if (!o) return null;
      const w = db.uploads.find((u) => u.id === o.artwork_id) || {};
      const artistId = `m_${o.artist_user}`;
      return { code: o.certificate, artwork_id: o.artwork_id, title: o.title, artist_id: artistId, artist: profileOf(db, o.artist_user).name,
        verified: (db.verified || []).some((v) => v.artist_id === artistId), year: w.year || null, medium: w.medium || null, dimensions: w.dimensions || null,
        edition_number: o.edition_number, edition_size: w.edition_size || null, issued_at: o.paid_at,
        valid: ['paid', 'shipped', 'delivered'].includes(o.status), status: o.status === 'refunded' ? 'void' : o.status === 'disputed' ? 'under_review' : 'valid' };
    },
    async artistIndexBadge(artistId) {
      const d = await this.indexWeek();
      const a = d.artists.find((x) => x.id === artistId);
      return a ? { week: d.week, covers_from: d.covers_from, chart: 'overall', rank: a.rank, name: a.name } : null;
    },
    async publishIndex() { const db = load(); needAdmin(db); return 1; },
    // ——— Checkout (same rules as 0017; Stripe stood in) ———
    async checkout(action, { artworkId } = {}) {
      needUser(); await wait();
      const db = load();
      if (!db.settings?.sales_enabled) throw new Error('Buying isn’t switched on yet.');
      db.payouts ||= {};
      if (action === 'onboard') { db.payouts[user.id] = { charges_enabled: true, payouts_enabled: true }; save(db); return { url: '#orders?payouts=done' }; }
      if (action === 'dashboard') return { url: '#orders' };
      const w = db.uploads.find((u) => u.id === artworkId);
      if (!w || w.owner === user.id) throw new Error('That’s your own work');
      if (!db.payouts[w.owner]?.charges_enabled) throw new Error('This artist can’t take payments yet. Ask them about it instead.');
      if ((w.availability || 'available') !== 'available' || !(w.price > 0)) throw new Error('This work isn’t for sale at a listed price');
      db.orders ||= [];
      const open = db.orders.filter((o) => o.artwork_id === w.id && o.status !== 'refunded').length;
      if (!w.edition_size && open) throw new Error('Someone is already buying this work');
      if (w.edition_size && open >= w.edition_size) throw new Error('This edition is sold out');
      const n = w.edition_size ? (w.editions_sold || 0) + 1 : null;
      if (w.edition_size) { w.editions_sold = n; if (n >= w.edition_size) w.availability = 'sold'; } else w.availability = 'sold';
      db.orders.push({ id: crypto.randomUUID(), artwork_id: w.id, title: w.title, artist_user: w.owner, buyer: user.id, amount_cents: w.price * 100, fee_cents: Math.round(w.price * 20),
        currency: 'usd', edition_number: n, status: 'paid', certificate: `ABR-${[0, 1, 2].map(() => Math.floor(Math.random() * 65536).toString(16).toUpperCase().padStart(4, '0')).join('-')}`, shipping: { name: profileOf(db, user.id).name, address: { city: 'Lisbon', country: 'PT' } }, paid_at: new Date().toISOString() });
      (db.notifications ||= []).push({ id: crypto.randomUUID(), user_id: w.owner, kind: 'sale', title: `You sold “${w.title}”. Ship it and add tracking in Orders.`, link: 'orders', created_at: new Date().toISOString(), read_at: null });
      save(db);
      return { url: '#orders?paid=1' };
    },
    async salesCatalog() {
      const db = load();
      if (!db.settings?.sales_enabled) return { accepting: [], editions: [] };
      return { accepting: Object.entries(db.payouts || {}).filter(([, p]) => p.charges_enabled).map(([u]) => `m_${u}`),
        editions: db.uploads.filter((u) => u.edition_size).map((u) => ({ id: u.id, edition_size: u.edition_size, editions_sold: u.editions_sold || 0 })) };
    },
    async myPayoutStatus() {
      const p = (load().payouts || {})[user?.id];
      return { connected: Boolean(p), charges_enabled: Boolean(p?.charges_enabled), payouts_enabled: Boolean(p?.payouts_enabled) };
    },
    async myOrders() {
      const db = load();
      const view = (o) => ({ ...o, buyer: profileOf(db, o.buyer).name, can_dispute: ['paid', 'shipped'].includes(o.status) || (o.status === 'delivered' && Date.parse(o.delivered_at) > Date.now() - 14 * 864e5) });
      return { sales: (db.orders || []).filter((o) => o.artist_user === user?.id).map(view), purchases: (db.orders || []).filter((o) => o.buyer === user?.id).map(({ shipping, ...o }) => view(o)) };
    },
    async markShipped(id, carrier, tracking) {
      const db = load();
      const o = (db.orders || []).find((x) => x.id === id && x.artist_user === user?.id && x.status === 'paid');
      if (!o) throw new Error('That order can’t be marked shipped');
      if (String(carrier).trim().length < 2 || String(tracking).trim().length < 4) throw new Error('Add the carrier and tracking number');
      Object.assign(o, { status: 'shipped', carrier, tracking, shipped_at: new Date().toISOString() });
      save(db);
    },
    async confirmDelivery(id) {
      const db = load();
      const o = (db.orders || []).find((x) => x.id === id && x.buyer === user?.id && x.status === 'shipped');
      if (!o) throw new Error('That order can’t be marked delivered');
      Object.assign(o, { status: 'delivered', delivered_at: new Date().toISOString() });
      save(db);
    },
    async openDispute(id, reason) {
      const db = load();
      if (String(reason).trim().length < 10) throw new Error('Describe the problem (at least 10 characters)');
      const o = (db.orders || []).find((x) => x.id === id && x.buyer === user?.id && ['paid', 'shipped', 'delivered'].includes(x.status));
      if (!o) throw new Error('Problems can be reported until 14 days after delivery');
      Object.assign(o, { status: 'disputed', dispute_reason: reason.trim(), was: o.status });
      save(db);
    },
    async disputes() {
      const db = load(); needAdmin(db);
      return (db.orders || []).filter((o) => o.status === 'disputed').map((o) => ({ ...o, reason: o.dispute_reason, buyer: profileOf(db, o.buyer).name, artist: profileOf(db, o.artist_user).name }));
    },
    async resolveDispute(id, refund, note) {
      const db = load(); needAdmin(db);
      const o = (db.orders || []).find((x) => x.id === id && x.status === 'disputed');
      if (!o) throw new Error('That order isn’t disputed');
      Object.assign(o, { status: refund ? 'refunded' : o.was, dispute_resolution: note || null });
      save(db);
    },
    async setEdition(id, size) {
      const db = load();
      const w = db.uploads.find((u) => u.id === id && u.owner === user?.id);
      if (!w) throw new Error('Not your artwork');
      if (size != null && (size < 2 || size > 500 || size < (w.editions_sold || 0))) throw new Error('An edition has 2 to 500 prints, and no fewer than already sold');
      w.edition_size = size;
      save(db);
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
  if (window.__guideMissing) delete api.guide; // a page half-updated from the previous version
  return api;
};
