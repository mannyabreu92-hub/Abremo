import { seasonName, STREAK_MILESTONES } from '../core/streak.js';
import { buildSeedWorld, CATEGORIES, STYLES, COUNTRIES, PALETTES, CURRENT_YEAR, categoryById, countryByCode } from '../core/seed.js';
import { ROLES, ROLE_WEIGHTS, SAVE_MULTIPLIER, influenceBreakdown, emptyRoleCounts } from '../core/scoring.js';
import { battleResult, expectedScore, pickBattlePair, kFactor, LOSS_FACTOR, START_RATING } from '../core/elo.js';
import { nextArtwork, updateTaste, topStyles, EXPLOIT_RATIO } from '../core/feed.js';
import { checkoutBreakdown } from '../core/marketplace.js';
import { BADGES, BADGE_RULES, userBadges } from '../core/badges.js';
import { rankMap, movement, rollSnapshot, hourKey } from '../core/rankings.js';
import { extractFeatures, classifyStyle, guessMedium, similarArtists } from '../core/recognition.js';
import { createWorld } from '../core/world.js';
import { mulberry32, hashString } from '../core/random.js';
import { artSVG } from './art.js';
import { loadState, saveState, resetState } from './store.js';
import { createSupabaseCloud } from './cloud.js';
import { prepareImage, blobToDataURL } from './images.js';
import { validateUpload, PRICE_MIN } from '../core/media.js';
import { credibility, dailyMasterpiece, dayKey, momentum, percentiles, artistSignals, SIGNALS, countryStandings } from '../core/insights.js';
import { tasteScore, personalInfluence, dailyActivity, earnedAchievements, ACHIEVEMENTS, COLLECTION_PRESETS, MIN_DISCOVERIES } from '../core/taste.js';
import { initPWA } from './pwa.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { emptyCommunity, snapshotToCommunity, mineToState, guestContributions, sampleCatalog, collectionsToState, AVAILABILITY, imageURL } from '../core/community.js';
import { artistProfileForm, validateArtistProfile, artworkEditForm, collectionEditForm } from './views/forms.js';
import { howRankedSheet } from './views/explainers.js';
import { inquirySheet, inboxPage, threadPage, dropsSection, dropPage, createDropForm } from './views/radar.js';
import { arenaTabs, competitionsHTML, historyHTML, competitionPage, enterSheet, createCompetitionForm, competitionCard } from './views/arena.js';
import { plansPage, galleryForm, galleryPageHTML, feedbackSheet, membershipCardHTML } from './views/membership.js';
import { welcomeCardHTML, tourSheet, joinPage, WELCOME_KEY } from './views/launch.js';
import { guidePanelHTML, replyHTML, GUIDE_COPY } from './views/assistant.js';
import { aboutHTML, installCardHTML, iosInstallHTML, signInHTML, accountCardHTML } from './views/account.js';
import {
  esc, fmt, money, flag, countryName, initials, Icon, ArtImage, Avatar, PremiumButton, IconButton, AbremiSymbol,
  ArtworkCard, ArtworkGrid, ArtistCard, CategoryFilter, Select, SearchBar,
  ArtBattleCard, BattleArena, CollectionCard, EmptyState, LoadingSkeleton, SectionHeader, Movement,
} from './components.js';

// ——— State ———
// Community mode: everyone's likes, follows and votes are shared through Supabase.
// Demo mode (no configuration): everything stays on this device, exactly as before.
const COMMUNITY = Boolean(window.__abremiCloud || (SUPABASE_URL && SUPABASE_ANON_KEY));
// Community mode shows the catalog as labelled sample works with no simulated activity:
// every like, follower, review and battle rating it shows is real.
const seed = COMMUNITY ? sampleCatalog(buildSeedWorld()) : buildSeedWorld();
let state = loadState();
let cloud = null; // backend adapter, once connected
let me = null; // signed-in account { id, email }
let pendingWrites = 0;
let pwa = null; // install + offline support, set up after the first render's helpers exist
let isAdmin = false; // can review Critic & Collector applications (checked by the server)
const auth = { stage: 'email', email: '', invite: '', busy: false, error: '' };
if (COMMUNITY) state.community ||= emptyCommunity();

/** What the rankings are computed from: this device's actions, or the whole community's. */
function viewState() {
  if (!COMMUNITY) return state;
  const c = state.community;
  return {
    ...state,
    deltas: c.deltas, elo: c.elo, followerDeltas: c.followerDeltas, rankedOnly: true, scores: c.scores || null,
    memberArtists: c.artists || [], memberArtworks: c.artworks || [], myArtistId: myArtistId(),
    uploads: [], // device-only demo uploads are not part of the shared catalog
  };
}
/** The viewer's own artist id: their member artist in community mode, the local 'me' in demo mode. */
function myArtistId() {
  return COMMUNITY ? (me ? `m_${me.id}` : null) : 'me';
}
/** Signed-in members and demo users move the rankings; guests in community mode do not. */
const counts = () => !COMMUNITY || Boolean(me);
let world = createWorld(seed, viewState());
const rng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let deck = [];
const discover = { category: '' };
let battlePair = null;
let battleOutcome = null; // { winner: index, res, crowd }
const charts = { tab: 'global', expanded: '', country: '', category: '', memberCountry: '', memberSeason: '', memberMedium: '' };
const explore = { category: '', style: '', country: '', sort: 'trending', limit: 24 };
const artistsView = { country: '', category: '', limit: 24 };
const homeFeed = { category: '', mode: 'trending' };
let sheetRenderer = null;

// Pages most visitors never open (moderation, Studio, orders, the Index, career tools) load on first
// use, so a first visit downloads less. lazyView() returns the module, or null while it loads; the
// page or sheet that asked is drawn again once it arrives. The service worker still precaches them.
const LAZY_VIEWS = {
  admin: () => import('./views/admin.js'),
  studio: () => import('./views/studio.js'),
  orders: () => import('./views/orders.js'),
  index: () => import('./views/index.js'),
  careers: () => import('./views/careers.js'),
};
const lazyModules = {};
const lazyLoading = {};
function lazyView(name) {
  if (lazyModules[name]) return lazyModules[name];
  if (!lazyLoading[name]) {
    const view = currentView(), sheet = sheetRenderer;
    lazyLoading[name] = LAZY_VIEWS[name]().then((m) => {
      lazyModules[name] = m;
      if (sheet && sheetRenderer === sheet) refreshSheet();
      else if (!sheetRenderer && currentView() === view) renderView();
    }).catch(() => {
      delete lazyLoading[name];
      toast('This page couldn’t load. Check your connection and try again.', { force: true });
    });
  }
  return null;
}
const lazyPage = (root, name) => {
  const m = lazyView(name);
  if (!m) root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 4, variant: 'list' })}</div>`;
  return m;
};
let lastFocus = null;
let lastScan = null;
let scanning = false;

function commit() {
  if (!saveState(state)) toast('Storage is full — some changes may not persist.');
  world = createWorld(seed, viewState());
}

// ——— Helpers ———
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const role = () => ROLES.find((r) => r.id === state.user.role);
const artistOf = (art) => world.artistById[art.artistId];
const reactionOf = (id) => state.interactions[id];
/** Community mode's catalog is sample content; say so wherever a sample work or artist is shown in full. */
const SampleNote = (kind) => `<p class="sample-note">${Icon('info', { size: 14 })} ${kind === 'artist'
  ? 'Sample artist: part of Abremi’s starter catalog, not a real person. Their followers and rankings come only from real members.'
  : 'Sample artwork from Abremi’s starter catalog. Not for sale; its likes, saves and rankings come only from real members.'}</p>`;
const cardCtx = (w, extra = {}) => ({ artist: artistOf(w), reaction: reactionOf(w.id), ...extra });
const card = (w, extra) => ArtworkCard(w, cardCtx(w, extra));
const isMine = (w) => w.artistId === myArtistId();
const catalog = () => world.artworks.filter((a) => !isMine(a));
const coverOf = (artistId) => (world.worksByArtist[artistId] || []).slice().sort((a, b) => world.influence[b.id] - world.influence[a.id])[0];

function toast(msg, { action, act, duration = 2400, force = false } = {}) {
  // A prompt with a button stays readable for a moment instead of being replaced by routine messages.
  if (!action && !force && Date.now() < (toast.holdUntil || 0)) return;
  toast.holdUntil = action ? Date.now() + 2500 : 0;
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.dataset.act = act;
    b.textContent = action;
    t.append(b);
  }
  t.classList.toggle('has-action', Boolean(action));
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show', 'has-action'), action ? Math.max(duration, 5000) : duration);
}

/** Once per visit, remind guests that their votes only count after signing in. */
function nudgeSignIn(what = 'admirations') {
  if (!COMMUNITY || me || nudgeSignIn.done) return;
  nudgeSignIn.done = true;
  toast(`Sign in so your ${what} count in the rankings`, { action: 'Sign in', act: 'sign-in' });
}

// ——— Modal ———
function openSheet(renderer, { wide = false } = {}) {
  if (!sheetRenderer) lastFocus = document.activeElement;
  sheetRenderer = renderer;
  const sheet = $('#sheet');
  $('#sheet-body').innerHTML = renderer();
  $('.modal-panel', sheet).classList.toggle('is-wide', wide);
  $('.modal-panel', sheet).scrollTop = 0;
  sheet.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    sheet.classList.add('open');
    $('.modal-close', sheet).focus({ preventScroll: true });
  });
}

function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  sheet.classList.remove('open');
  sheetRenderer = null;
  sheetArtworkId = null;
  document.body.classList.remove('modal-open');
  setTimeout(() => { if (!sheetRenderer) sheet.hidden = true; }, 240);
  lastFocus?.focus?.({ preventScroll: true });
}

function refresh() {
  renderView();
  // A sheet holding a form (inquiry, profile, drop…) keeps what's being typed; other sheets redraw.
  if (sheetRenderer && !$('#sheet-body form')) $('#sheet-body').innerHTML = sheetRenderer();
}

// ——— Router ———
const VIEWS = {
  home: renderHome, discover: renderDiscover, explore: renderExplore, battle: renderBattle, artists: renderArtists,
  collections: renderCollections, charts: renderCharts, scan: renderScan, profile: renderProfile, artist: renderArtistPage, admin: renderAdmin,
  art: renderArtworkPage, collection: renderSharedCollection, competition: renderCompetition, studio: renderStudio,
  inbox: renderInbox, inquiry: renderInquiry, drop: renderDrop, coach: renderCoach, opportunities: renderOpportunities,
  plans: renderPlans, gallery: renderGallery, index: renderIndex, orders: renderOrders, join: renderJoin,
};
/** #view or #view/param (e.g. #artist/a12). Unknown routes fall back to home. */
function route() {
  const [name, ...rest] = location.hash.slice(1).split('?')[0].split('/'); // '?…' carries messages, e.g. #orders?paid=1
  return VIEWS[name] ? { name, param: decodeURIComponent(rest.join('/')) } : { name: 'home', param: '' };
}
const currentView = () => route().name;
const NAV_SECTION = { artist: 'artists', art: 'explore', collection: 'collections', competition: 'battle', studio: 'profile', inbox: 'profile', inquiry: 'profile', drop: 'home', coach: 'profile', opportunities: 'artists' };

function renderView() {
  const name = currentView();
  $$('[data-view]').forEach((a) => {
    const on = a.dataset.view === (NAV_SECTION[name] || name);
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const r = role();
  const navProfile = $('#nav-profile');
  if (COMMUNITY && !me) {
    navProfile.innerHTML = '<span class="nav-signin">Sign in</span>';
    navProfile.dataset.act = 'sign-in';
  } else {
    navProfile.innerHTML = `<span class="avatar avatar-sm avatar-me">${esc(initials(state.user.name))}</span><span class="nav-role">${r.label} <b>×${r.weight}</b></span>`;
    delete navProfile.dataset.act;
  }
  updateNotificationDot();
  const menuInstall = $('#menu-install');
  if (menuInstall) menuInstall.hidden = !pwa?.status().available;
  const menuAdmin = $('#menu-admin');
  if (menuAdmin) menuAdmin.hidden = !(COMMUNITY && me && isAdmin);
  const menuInbox = $('#menu-inbox');
  if (menuInbox) {
    menuInbox.hidden = !(COMMUNITY && me);
    const unread = (radar.list || []).filter((q) => q.unread).length;
    menuInbox.textContent = unread ? `Inbox (${unread})` : 'Inbox';
  }
  VIEWS[name]($('#view'));
  observeImpressions();
  renderGuide();
}

// ——— Analytics (community mode): impressions, artwork views and profile visits of member work ———
// Each is sent once per day per work or page; the server counts each person once a day, ignores
// artists' own views, and never uses these for rankings.
const trackedToday = new Set();
const pendingEvents = [];
let flushTimer = null;
function guestKey() {
  try {
    let k = localStorage.getItem('abremi:guest-key');
    if (!k) { k = crypto.randomUUID(); localStorage.setItem('abremi:guest-key', k); }
    return k;
  } catch { return null; }
}
function track(kind, target) {
  if (!COMMUNITY || !target) return;
  const key = `${kind}:${target}:${new Date().toISOString().slice(0, 10)}`;
  if (trackedToday.has(key)) return;
  trackedToday.add(key);
  pendingEvents.push({ k: kind, t: target });
  if (pendingEvents.length >= 50) flushEvents();
  else flushTimer ||= setTimeout(flushEvents, 5000);
}
function flushEvents() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!cloud?.recordEvents || !pendingEvents.length) return;
  const batch = pendingEvents.splice(0, 100);
  cloud.recordEvents(batch, me ? null : guestKey()).catch(() => {});
}
const trackArtwork = (kind, id) => { const w = world.artworkById[id]; if (w?.member && !isMine(w)) track(kind, id); };
const impressionObserver = COMMUNITY && 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { impressionObserver.unobserve(e.target); trackArtwork('impression', e.target.dataset.id); }
  }, { threshold: 0.5 })
  : null;
function observeImpressions() {
  if (!impressionObserver) return;
  impressionObserver.disconnect();
  $$('#view .art-frame[data-id], #view .swipe-card.is-top[data-id], #view .rank-row[data-act=artwork][data-id]').forEach((el) => impressionObserver.observe(el));
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushEvents(); });

function navigate() {
  closeSheet();
  closePopovers();
  closeSearch();
  const swap = () => {
    renderView();
    window.scrollTo(0, 0);
  };
  if (document.startViewTransition && !reducedMotion.matches) {
    // A transition can be skipped (e.g. the phone rotates mid-way); the new page still renders.
    const t = document.startViewTransition(swap);
    for (const p of [t.ready, t.finished, t.updateCallbackDone]) p?.catch(() => {});
  }
  else {
    swap();
    const v = $('#view');
    v.classList.remove('view-enter');
    void v.offsetWidth;
    v.classList.add('view-enter');
  }
}

// ——— Reactions (like / save / pass) ———
/** Where a contribution is tallied: this device (demo), the community (members), or nowhere (guests). */
function ensureDelta(id) {
  const target = !COMMUNITY ? state.deltas : me ? state.community.deltas : null;
  if (!target) return { likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } };
  return (target[id] ||= { likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } });
}

/** Send a write to the server; on failure, say so and reload the truth. */
function remote(task, failMessage = 'Could not save that. Check your connection.') {
  if (!cloud || !me) return;
  pendingWrites++;
  Promise.resolve()
    .then(task)
    .catch((e) => {
      toast(e?.message && !/fetch|network/i.test(e.message) ? e.message : failMessage);
      return resync();
    })
    .finally(() => { pendingWrites--; });
}

/** Move an artwork between none / like / super / pass, keeping influence deltas exact. */
function setReaction(art, next) {
  const id = art.id;
  const prev = state.interactions[id];
  if (prev === next) return;
  const before = standingOf(id);
  const pointsBefore = contributionOf(prev, state.interactionRoles?.[id]);
  const prevRole = state.interactionRoles?.[id] || state.user.role;
  if ((prev === 'like' || prev === 'super') && !(COMMUNITY && isMine(art))) {
    const d = ensureDelta(id);
    const bucket = prev === 'like' ? d.likes : d.saves;
    bucket[prevRole] = Math.max(0, (bucket[prevRole] || 0) - 1);
  }
  state.interactionRoles ||= {};
  const own = COMMUNITY && isMine(art); // your own likes are kept for you, but never count
  if (next) {
    const r = state.user.role;
    if (next === 'like' && !own) ensureDelta(id).likes[r]++;
    if (next === 'super' && !own) ensureDelta(id).saves[r]++;
    state.interactions[id] = next;
    state.interactionRoles[id] = r;
    if (next !== prev && !(prev === 'like' && next === 'super')) state.taste = updateTaste(state.taste, art, next);
  } else {
    delete state.interactions[id];
    delete state.interactionRoles[id];
  }
  // Remember how well-known the work was when you found it: the basis of your Taste Score.
  if ((next === 'like' || next === 'super') && !state.discoveries[id]) {
    state.discoveries[id] = { at: Date.now(), rankAt: before.rank, influenceAt: before.influence, style: art.style };
  }
  const added = own ? 0 : contributionOf(next, state.interactionRoles?.[id]) - pointsBefore;
  if (own && next && next !== 'pass' && !prev) toast('Saved for you. Your own admirations don’t count toward rankings.');
  if (added && counts()) {
    state.activity.push({ t: Date.now(), id, pts: added });
    if (state.activity.length > 600) state.activity.splice(0, state.activity.length - 600);
  }
  commit();
  if (added > 0 && counts()) influenceFeedback(added, before, standingOf(id), next === 'super');
  checkAchievements();
  if (COMMUNITY) { // every artwork in community mode (catalog or member upload) exists on the server
    if (me) remote(() => cloud.setReaction(id, next || null));
    else if (next === 'like' || next === 'super') nudgeSignIn('admirations');
  }
}

// ——— Influence, taste and achievements (all from real activity) ———
function contributionOf(kind, roleId) {
  const w = ROLE_WEIGHTS[roleId || state.user.role] || 1;
  return kind === 'like' ? w : kind === 'super' ? w * SAVE_MULTIPLIER : 0;
}

let rankCache = null;
function currentRanks() {
  if (!rankCache || rankCache.world !== world) rankCache = { world, map: rankMap(world.topArtworks()) };
  return rankCache.map;
}

function standingOf(id) {
  return { rank: currentRanks()[id] ?? world.artworks.length, influence: world.influence[id] ?? 0 };
}

/** "+3 Influence added", plus the work's climb when your vote moved it. */
function influenceFeedback(points, before, after, superLike = false) {
  const chip = document.createElement('div');
  chip.className = 'influence-chip';
  const climbed = before.rank - after.rank;
  chip.innerHTML = `${superLike ? 'Treasured · ' : ''}<b>+${points}</b> Influence added${climbed > 0 ? `<span>↑ ${climbed} to No. ${after.rank}</span>` : ''}`;
  document.body.append(chip);
  setTimeout(() => chip.remove(), 2200);
}

function myDiscoveries() {
  return Object.entries(state.discoveries)
    .filter(([id]) => (state.interactions[id] === 'like' || state.interactions[id] === 'super') && world.artworkById[id])
    .map(([id, d]) => ({ id, ...d }));
}

function standingsNow() {
  const ranks = currentRanks();
  return { rankOf: (id) => ranks[id] ?? null, influenceOf: (id) => world.influence[id] ?? 0, total: world.artworks.length };
}

function myTaste() {
  return tasteScore(myDiscoveries(), standingsNow());
}

function followersTotal(artistId) {
  const a = world.artistById[artistId];
  return a ? Object.values(world.followersOf(a)).reduce((x, y) => x + y, 0) : 0;
}

// Community mode: achievements are earned on the server (with evidence and public criteria);
// demo mode keeps the on-device ones.
let serverAchievements = { defs: null, earned: [] };
async function loadAchievements() {
  if (!cloud?.achievementDefinitions) return;
  try {
    const [defs, earned] = await Promise.all([
      serverAchievements.defs ? null : cloud.achievementDefinitions(),
      me ? cloud.myAchievements() : [],
    ]);
    if (defs) serverAchievements.defs = Object.fromEntries(defs.map((d) => [d.code, { label: d.label, desc: d.criteria, audience: d.audience }]));
    serverAchievements.earned = earned || [];
    // Season places are defined when a season closes: take their labels from what you earned.
    for (const a of serverAchievements.earned) if (a.label && !serverAchievements.defs[a.code]) serverAchievements.defs[a.code] = { label: a.label, desc: a.criteria, audience: a.audience || 'member' };
    if (me) loadStreak();
    if (me) checkAchievements();
  } catch { /* older database without achievements: nothing to show */ }
}
// ——— Art Battle streak (community mode; computed by the server) ———
let myStreak = null;
async function loadStreak() {
  if (!cloud?.myBattleStreak || !me) return;
  try { myStreak = await cloud.myBattleStreak(); } catch { myStreak = null; return; }
  const slot = $('#streak-slot'); // update in place: a full re-render would wipe forms on the page
  if (slot) slot.innerHTML = streakCardHTML();
}
function streakCardHTML() {
  if (!COMMUNITY || !me || !myStreak) return '';
  const s = myStreak;
  const next = STREAK_MILESTONES.find((n) => n > s.best);
  const note = s.current && !s.today ? 'Vote today to keep it going.' : s.today ? 'You’ve voted today.' : 'Vote in the Art Battle to start one.';
  return `<section class="panel streak-panel">
    <p class="eyebrow">Art Battle streak</p>
    <p class="influence-total">${s.current}<small> day${s.current === 1 ? '' : 's'}</small></p>
    <p class="muted">${esc(note)} Best: ${s.best} day${s.best === 1 ? '' : 's'}.${next ? ` Next milestone: ${next} days.` : ''}</p>
    <p class="fine">One vote a day (UTC) keeps it going; one missed day a week is forgiven${s.grace_used ? ', and you’ve used this week’s' : ''}.</p>
  </section>`;
}

/** { code: { label, desc } } for the achievements this mode uses. */
const achievementCatalog = () => (COMMUNITY ? serverAchievements.defs || {} : ACHIEVEMENTS);

function myAchievements(taste = myTaste()) {
  if (COMMUNITY) return me ? serverAchievements.earned.map((a) => a.code) : [];
  return earnedAchievements({
    discoveries: myDiscoveries(),
    now: standingsNow(),
    collections: state.collections,
    taste,
    follows: Object.fromEntries(Object.keys(state.follows).filter((id) => state.followMeta[id]).map((id) => [id, state.followMeta[id]])),
    followersNow: followersTotal,
  });
}

let celebrating = false;
const celebrationQueue = [];
function checkAchievements() {
  const fresh = myAchievements().filter((a) => !state.achievementsSeen.includes(a));
  if (!fresh.length) return;
  state.achievementsSeen.push(...fresh);
  saveState(state);
  celebrationQueue.push(...fresh);
  if (!celebrating) nextCelebration();
}

function nextCelebration() {
  const id = celebrationQueue.shift();
  if (!id) { celebrating = false; return; }
  celebrating = true;
  const a = achievementCatalog()[id];
  if (!a) { nextCelebration(); return; }
  const el = document.createElement('div');
  el.className = 'celebrate';
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="celebrate-card"><span class="celebrate-mark">${AbremiSymbol(30)}</span>
    <p class="eyebrow">Achievement unlocked</p><h3 class="display-sm">${esc(a.label)}</h3><p>${esc(a.desc)}</p>
    <span class="sparks" aria-hidden="true">${'<i></i>'.repeat(10)}</span></div>`;
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    el.classList.add('out');
    setTimeout(() => { el.remove(); nextCelebration(); }, 260);
  };
  el.addEventListener('click', done);
  document.body.append(el);
  setTimeout(done, 3600);
}

function react(art, kind) {
  const prev = reactionOf(art.id);
  const purchased = state.purchases.some((p) => p.artworkId === art.id);
  let next;
  if (kind === 'like') next = prev === 'like' || prev === 'super' ? null : 'like';
  else next = prev === 'super' ? 'like' : 'super';
  if (purchased && prev === 'super') return toast('Purchased works stay in your collection.');
  setReaction(art, next);
  deck = deck.filter((d) => d.artwork.id !== art.id);
  if (next === 'super' && !counts()) toast(`Saved “${art.title}” to your collection`);
  else if (next === 'like' && !counts() && nudgeSignIn.done) toast('Liked');
  syncReactionButtons(art.id);
}

function syncReactionButtons(id) {
  const r = reactionOf(id);
  $$(`[data-act="react"][data-id="${id}"]`).forEach((b) => {
    const on = b.dataset.v === 'like' ? r === 'like' || r === 'super' : r === 'super';
    const changed = b.classList.contains('is-on') !== on;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
    if (changed && on && !reducedMotion.matches) {
      b.classList.remove('pop');
      void b.offsetWidth;
      b.classList.add('pop');
    }
  });
  if (['collections', 'profile'].includes(currentView())) renderView();
  if (sheetRenderer) $('#sheet-body').innerHTML = sheetRenderer();
}

// ——— Home ———
// ——— Cultural signals for artists (cached per world) ———
let insightCache = null;
function artistInsights() {
  if (insightCache?.world === world) return insightCache;
  const prev = (COMMUNITY ? baselineRanks()?.artist : state.snapshot?.prev?.artist) || null;
  const influenceOf = {}, cred = {};
  for (const a of world.artists) {
    const works = world.worksByArtist[a.id] || [];
    const agg = { likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } };
    for (const w of works) {
      const c = world.countsOf(w);
      for (const r of Object.keys(agg.likes)) { agg.likes[r] += c.likes[r] || 0; agg.saves[r] += c.saves[r] || 0; }
      agg.reviews.count += c.reviews?.count || 0;
      agg.reviews.ratingSum += c.reviews?.ratingSum || 0;
    }
    influenceOf[a.id] = works.reduce((s, w) => s + world.influence[w.id], 0);
    cred[a.id] = credibility(agg);
  }
  const mom = Object.fromEntries(world.artists.map((a) => [a.id, momentum(influenceOf[a.id], followersTotal(a.id))]));
  const pct = percentiles(Object.values(mom));
  const signals = {};
  for (const a of world.artists) {
    signals[a.id] = artistSignals({
      rankDelta: prev && prev[a.id] != null ? prev[a.id] - world.globalArtistRanks[a.id] : null,
      momentumPercentile: pct(mom[a.id]),
      collectorShare: cred[a.id].collectorShare,
      globalRank: world.globalArtistRanks[a.id],
      debutYear: a.debutYear,
      currentYear: CURRENT_YEAR,
    });
  }
  insightCache = { world, signals, cred, mom, pct };
  return insightCache;
}

function signalChips(artistId, { compact = false } = {}) {
  const list = artistInsights().signals[artistId] || [];
  return list.map((k) => `<span class="signal signal-${k}" title="${esc(SIGNALS[k].desc)}">${SIGNALS[k].icon}${compact ? '' : ` ${SIGNALS[k].label}`}</span>`).join('');
}

const credOf = (w) => credibility(world.countsOf(w)).share;

/** Today's Daily Masterpiece, fixed for the day once revealed on this device. */
function todaysMasterpiece() {
  const today = dayKey();
  const kept = state.masterpiece?.day === today && world.artworkById[state.masterpiece.id];
  if (kept) {
    const ranks = currentRanks();
    return { artwork: kept, rank: ranks[kept.id], day: today, revealAt: (() => { const d = new Date(); d.setHours(24, 0, 0, 0); return d; })() };
  }
  const pick = dailyMasterpiece(world.topArtworks().filter((r) => r.rank != null && !isMine(r.item)), credOf, new Date());
  if (pick) { state.masterpiece = { day: today, id: pick.artwork.id }; saveState(state); }
  return pick;
}

const countdown = (ts) => `<b class="countdown" data-countdown="${ts}">${formatCountdown(ts - Date.now())}</b>`;
function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function masterpieceHTML(mp, { compact = false } = {}) {
  if (!mp) return '';
  const w = mp.artwork, a = artistOf(w);
  const c = credibility(world.countsOf(w));
  const r = reactionOf(w.id);
  const date = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return `<section class="masterpiece${compact ? ' is-compact' : ''} spotlight" aria-label="Daily Masterpiece">
    <button class="mp-frame" data-act="artwork" data-id="${w.id}" aria-label="View ${esc(w.title)}">${ArtImage(w, { full: true })}</button>
    <div class="mp-body">
      <p class="eyebrow mp-eyebrow">${AbremiSymbol(14)} Daily Masterpiece · ${esc(date)}</p>
      <h2 class="display-md">${esc(w.title)}</h2>
      <button class="artist-line" data-act="artist" data-id="${a.id}">${Avatar(a, 'sm')}<span><b>${esc(a.name)}</b><small>${esc(countryName(a.country))}</small></span></button>
      <ul class="mp-why">
        <li><span>Standing</span><b>No. ${mp.rank} worldwide</b></li>
        <li><span>Credibility</span><b>${Math.round(c.share * 100)}% from critics &amp; collectors</b></li>
        <li><span>Work</span><b>${esc(w.medium)} · ${w.year}</b></li>
      </ul>
      <p class="mp-note">Chosen each day from the 60 most influential works, favouring those critics and collectors rate highest.</p>
      <div class="mp-actions">
        <button class="btn btn-icon${r === 'like' || r === 'super' ? ' is-on' : ''}" data-act="react" data-v="like" data-id="${w.id}" aria-pressed="${r === 'like' || r === 'super'}" aria-label="Admire">${Icon('admire', { size: 18 })}</button>
        ${PremiumButton('Add to collection', { act: 'add-to-collection', variant: 'secondary', icon: 'folderPlus', attrs: `data-id="${w.id}"` })}
        <span class="mp-next">${Icon('clock', { size: 16 })} Next reveal in ${countdown(mp.revealAt.getTime())}</span>
      </div>
    </div>
  </section>`;
}

// ——— Home ———
function renderHome(root) {
  const top = world.topArtworks();
  const mp = todaysMasterpiece();
  if (mp && state.masterpieceSeen !== mp.day) { state.masterpieceSeen = mp.day; saveState(state); }
  const heroArt = mp?.artwork || top[0].item;
  const nothingRanked = COMMUNITY && top[0]?.rank == null;
  const feedSource = homeFeed.mode === 'following'
    ? catalog().filter((w) => state.follows[w.artistId]).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || world.influence[b.id] - world.influence[a.id])
    : homeFeed.mode === 'new'
    ? catalog().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.year - a.year || world.influence[b.id] - world.influence[a.id])
    : top.map((r) => r.item);
  const feed = feedSource.filter((w) => !homeFeed.category || w.category === homeFeed.category).slice(0, 8);
  const ins = artistInsights();
  const rising = world.artists.filter((a) => !a.isMe && ins.signals[a.id]?.includes('rising'))
    .sort((a, b) => ins.mom[b.id] - ins.mom[a.id]).slice(0, 4);
  if (!battlePair) newBattle();
  const countries = countryBoard().slice(0, 5);
  const members = COMMUNITY ? state.community?.members || 0 : 0;
  const proof = members
    ? `${fmt(members)} member${members === 1 ? '' : 's'} shaping the rankings`
    : `${fmt(world.artists.filter((a) => !a.isMe).length)} artists · ${COUNTRIES.length} countries · ${fmt(catalog().length)} works`;

  root.innerHTML = `<div class="home">
    <section class="hero landing">
      <div class="landing-art spotlight">
        <button class="landing-frame" data-act="artwork" data-id="${heroArt.id}" aria-label="View ${esc(heroArt.title)}">${ArtImage(heroArt, { eager: true })}</button>
      </div>
      <div class="landing-copy shell">
        <p class="eyebrow">A new generation of art discovery</p>
        <h1 class="display-hero">Discover Art.<br><span class="gold-serif">Shape Culture.</span></h1>
        <p class="lede">Swipe. Collect. Support.<br>The global art discovery platform.</p>
        <div class="hero-actions">
          <a class="btn btn-primary btn-lg" href="#discover"><span>Start Exploring</span>${Icon('arrow', { size: 18 })}</a>
          <a class="text-link" href="#charts">Explore Rankings</a>
        </div>
        <p class="landing-proof">${esc(proof)}</p>
        ${pwa?.status().available ? `<button class="link-arrow get-app" data-act="pwa-install">${Icon('download', { size: 16 })} Get the Abremi app</button>` : ''}
      </div>
    </section>

    <div class="shell">
      ${welcomed() ? '' : welcomeCardHTML()}
      ${masterpieceHTML(mp)}
      ${foundingHTML()}
      ${COMMUNITY ? (radar.drops ? dropsSection(radar.drops, { image: storageImage }) : (loadDrops(), '')) : ''}
      ${emergingHTML()}

      ${rising.length ? `<section class="section">
        ${SectionHeader({ eyebrow: 'Discover them first', title: 'Rising artists', action: `<a class="link-arrow" href="#artists">All artists ${Icon('arrow', { size: 16 })}</a>` })}
        <div class="artist-grid">${rising.map((a) => ArtistCard(a, { cover: coverOf(a.id), following: !!state.follows[a.id], rank: world.globalArtistRanks[a.id], signals: signalChips(a.id) })).join('')}</div>
      </section>` : ''}

      <section class="section">
        ${SectionHeader({ eyebrow: 'Discover', title: homeFeed.mode === 'following' ? 'From artists you follow' : homeFeed.mode === 'new' ? 'New discoveries' : nothingRanked ? 'Sample works' : 'Trending now', action: `<div class="seg seg-sm" role="tablist">
          <button role="tab" class="${homeFeed.mode === 'trending' ? 'is-on' : ''}" aria-selected="${homeFeed.mode === 'trending'}" data-act="home-mode" data-v="trending">Trending</button>
          <button role="tab" class="${homeFeed.mode === 'new' ? 'is-on' : ''}" aria-selected="${homeFeed.mode === 'new'}" data-act="home-mode" data-v="new">New</button>
          <button role="tab" class="${homeFeed.mode === 'following' ? 'is-on' : ''}" aria-selected="${homeFeed.mode === 'following'}" data-act="home-mode" data-v="following">Following</button></div>` })}
        ${CategoryFilter(CATEGORIES, homeFeed.category, { act: 'home-cat', allLabel: 'All', pills: true })}
        ${feed.length ? ArtworkGrid(feed.map((w) => card(w))) : homeFeed.mode === 'following'
          ? EmptyState({ icon: 'user', title: Object.keys(state.follows).length ? 'Nothing from them here yet' : 'Follow artists to see their work here', body: 'Newest works from the artists you follow appear first.', action: '<a class="btn btn-secondary" href="#artists"><span>Find artists</span></a>' })
          : EmptyState({ title: 'Nothing here yet', body: 'Try another medium.' })}
        <div class="section-foot"><a class="link-arrow" href="#explore">Explore all works ${Icon('arrow', { size: 16 })}</a></div>
      </section>

      <section class="section battle-section">
        ${SectionHeader({ eyebrow: 'Art Battle', title: 'Vote for your favourite masterpiece', action: `<a class="link-arrow" href="#battle">Open the arena ${Icon('arrow', { size: 16 })}</a>` })}
        ${battleArenaHTML(true)}
      </section>

      <section class="section home-boards">
        <div>
          ${SectionHeader({ eyebrow: 'Rankings', title: 'Top artworks worldwide', action: `<a class="link-arrow" href="#charts">See all ${Icon('arrow', { size: 16 })}</a>` })}
          <ol class="rank-list">${top.slice(0, 5).map((r) => rankRow(r, 'art', undefined)).join('')}</ol>
        </div>
        <div>
          ${SectionHeader({ eyebrow: 'Countries', title: 'Cultural influence by country', action: `<button class="link-arrow" data-act="charts-goto" data-v="countries">All countries ${Icon('arrow', { size: 16 })}</button>` })}
          <ol class="rank-list">${countries.map(countryRow).join('')}</ol>
        </div>
      </section>
      ${footerHTML()}
    </div>
  </div>`;
}

function footerHTML() {
  return `<footer class="footer">${AbremiSymbol(18)}<span class="brand-word">Abremi</span><span>Discover art. Shape culture.</span>
    <nav class="footer-links" aria-label="More"><a href="#join">For artists</a><a href="#index">The Index</a><a href="#opportunities">Opportunities</a><a href="#plans">Plans</a>${COMMUNITY ? '<button class="link" data-act="feedback-open">Send feedback</button>' : ''}<button class="link" data-act="about">About</button></nav></footer>`;
}

// ——— Discover (swipe) ———
function fillDeck() {
  const seen = new Set([...Object.keys(state.interactions), ...deck.map((d) => d.artwork.id)]);
  const pool = catalog().filter((a) => !discover.category || a.category === discover.category);
  const preferred = interestPool(pool);
  while (deck.length < 3) {
    // Mostly from the member's chosen interests (when they have enough works), always with some exploring.
    const from = preferred.filter((a) => !seen.has(a.id)).length >= 6 && rng() < 0.7 ? preferred : pool;
    const n = nextArtwork(from, state.taste, rng, { seen, popularity: (a) => world.influence[a.id] }) || nextArtwork(pool, state.taste, rng, { seen, popularity: (a) => world.influence[a.id] });
    if (!n) break;
    deck.push(n);
    seen.add(n.artwork.id);
  }
}

const DISCOVER_LABELS = { oil: 'Painting', photography: 'Photography', digital: 'Digital Art', sculpture: 'Sculpture', street: 'Street Art', mixed: 'Mixed Media', illustration: 'Illustration', ai: 'AI Art', nft: 'NFT' };

function swipeCardHTML({ artwork: w, reason }, top) {
  const a = artistOf(w);
  const rankNow = currentRanks()[w.id];
  const sig = artistInsights().signals[a.id] || [];
  const badge = rankNow <= 50 ? '<span class="trend-badge">🔥 Trending</span>'
    : sig.includes('rising') ? '<span class="trend-badge">🔥 Rising artist</span>'
      : sig.includes('collector') ? '<span class="trend-badge">⭐ Collector attention</span>' : '';
  const r = reactionOf(w.id);
  return `<article class="swipe-card${top ? ' is-top' : ''}" data-id="${w.id}" ${top ? 'tabindex="0" aria-label="' + esc(`${w.title} by ${a.name}. Tap for details.`) + '"' : 'aria-hidden="true"'}>
    <div class="swipe-art">${ArtImage(w, { eager: true })}</div>
    ${badge}
    <span class="stamp stamp-like">Admire</span><span class="stamp stamp-nope">Pass</span><span class="stamp stamp-super">Treasure</span>
    ${top ? `<button class="swipe-info icon-btn" data-act="artwork" data-id="${w.id}" aria-label="Artwork details">${Icon('info')}</button>` : ''}
    <div class="swipe-caption">
      <p class="eyebrow swipe-reason">${esc(reason)}</p>
      <h2 class="swipe-title">${esc(w.title)}</h2>
      <div class="swipe-by">
        <button class="artist-line" data-act="artist" data-id="${a.id}">${Avatar(a, 'sm')}<span><b>${esc(a.name)}</b><small>${esc(w.medium)} • ${w.year}</small></span></button>
        ${top ? `<button class="swipe-heart${r === 'like' || r === 'super' ? ' is-on' : ''}" data-act="react" data-v="like" data-id="${w.id}" aria-pressed="${r === 'like' || r === 'super'}" aria-label="Admire">${Icon('admire', { size: 22 })}</button>` : ''}
      </div>
    </div>
  </article>`;
}

function discoverPanelHTML(entry) {
  if (!entry) return '';
  const w = entry.artwork, a = artistOf(w);
  const following = !!state.follows[a.id];
  const rankNow = currentRanks()[w.id];
  const c = credibility(world.countsOf(w));
  return `<p class="eyebrow">Now viewing</p>
    <h2 class="display-sm">${esc(w.title)}</h2>
    <div class="panel-artist">
      <button class="artist-line" data-act="artist" data-id="${a.id}">${Avatar(a, 'sm')}<span><b>${esc(a.name)}</b><small>${esc(countryName(a.country))}</small></span></button>
      <button class="follow-btn${following ? ' is-on' : ''}" data-act="follow" data-id="${a.id}" aria-pressed="${following}">${following ? 'Following' : 'Follow'}</button>
    </div>
    <div class="signal-row">${signalChips(a.id)}</div>
    <dl class="spec spec-stack">
      <div><dt>Medium</dt><dd>${esc(w.medium)}</dd></div>
      <div><dt>Movement</dt><dd>${esc(w.style)}</dd></div>
      <div><dt>Ranking</dt><dd>No. ${rankNow} worldwide</dd></div>
      <div><dt>Influence</dt><dd>${fmt(world.influence[w.id])}</dd></div>
      <div><dt>Credibility</dt><dd>${Math.round(c.share * 100)}% critics &amp; collectors</dd></div>
      ${w.sample ? '<div><dt>Status</dt><dd>Sample work</dd></div>' : `<div><dt>Price</dt><dd>${money(w.price)}</dd></div>`}
    </dl>
    <div class="panel-actions">
      ${PremiumButton('View details', { act: 'artwork', variant: w.sample ? 'primary' : 'secondary', attrs: `data-id="${w.id}"` })}
      ${w.sample ? '' : PremiumButton('Inquire', { act: 'buy', variant: 'primary', attrs: `data-id="${w.id}"` })}
      ${state.user.role === 'critic' ? PremiumButton('Write review', { act: 'review', variant: 'ghost', icon: 'pen', attrs: `data-id="${w.id}"` }) : ''}
    </div>
    <p class="fine">${counts() ? `Your ${role().label.toLowerCase()} vote adds ${role().weight} influence (${role().weight * SAVE_MULTIPLIER} for a Treasure).` : '<button class="link" data-act="sign-in">Sign in</button> so your admirations count in the rankings.'} Keys: ← pass, → admire, ↑ treasure, Enter for details.</p>`;
}

function renderDiscover(root) {
  fillDeck();
  const top = deck[0];
  const order = ['oil', 'photography', 'digital', 'sculpture', 'street', 'mixed', 'illustration', 'ai', 'nft'];
  const cats = order.map((id) => ({ id, label: DISCOVER_LABELS[id] || categoryById[id].label }));
  root.innerHTML = `<div class="shell discover">
    <h1 class="sr-only">Discover</h1>
    ${CategoryFilter(cats, discover.category, { act: 'discover-cat', allLabel: 'All', pills: true })}
    <div class="discover-stage">
      <div class="deck-col">
        <div class="deck" id="deck">
          ${deck.length ? deck.slice(0, 2).reverse().map((d, i, arr) => swipeCardHTML(d, i === arr.length - 1)).join('') : EmptyState({
            title: discover.category ? 'You have seen this medium' : 'You have seen everything',
            body: 'Start over, or try another medium.',
            action: PremiumButton('Start over', { act: 'reset-swipes', variant: 'secondary' }),
          })}
        </div>
        ${top ? `<div class="deck-actions" role="group" aria-label="Your verdict on this work">
          <span class="deck-act"><button class="deck-btn deck-pass" data-act="swipe" data-dir="pass" aria-label="Pass">${Icon('brush', { size: 26 })}</button><small aria-hidden="true">Pass</small></span>
          <span class="deck-act deck-act-treasure"><button class="deck-btn deck-super" data-act="swipe" data-dir="super" aria-label="Treasure: save it to your Treasures (counts twice)">${Icon('treasure', { size: 24 })}</button><small aria-hidden="true">Treasure</small></span>
          <span class="deck-act deck-act-admire"><button class="deck-btn deck-like" data-act="swipe" data-dir="like" aria-label="Admire">${Icon('admire', { size: 30 })}</button><small aria-hidden="true">Admire</small></span>
        </div>` : ''}
      </div>
      <aside class="discover-panel" aria-live="polite">${discoverPanelHTML(top)}</aside>
    </div>
  </div>`;
  const c = $('.swipe-card.is-top', root);
  if (c) attachDrag(c);
}

function attachDrag(cardEl) {
  let sx = 0, sy = 0, dx = 0, dy = 0, t0 = 0, dragging = false;
  const stamps = { like: $('.stamp-like', cardEl), nope: $('.stamp-nope', cardEl), super: $('.stamp-super', cardEl) };
  cardEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; t0 = Date.now();
    cardEl.setPointerCapture(e.pointerId);
    cardEl.style.transition = 'none';
  });
  cardEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    cardEl.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
    const up = -dy > Math.abs(dx);
    stamps.like.style.opacity = up ? 0 : Math.max(0, Math.min(1, dx / 100));
    stamps.nope.style.opacity = up ? 0 : Math.max(0, Math.min(1, -dx / 100));
    stamps.super.style.opacity = up ? Math.max(0, Math.min(1, -dy / 100)) : 0;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && Date.now() - t0 < 450) { // a tap: open the artwork
      cardEl.style.transform = '';
      return openSheet(() => artworkSheet(cardEl.dataset.id), { wide: true });
    }
    if (-dy > 110 && -dy > Math.abs(dx)) return decide('super');
    if (dx > 110) return decide('like');
    if (dx < -110) return decide('pass');
    cardEl.style.transition = 'transform .3s cubic-bezier(.2,.8,.2,1)';
    cardEl.style.transform = '';
    Object.values(stamps).forEach((s) => { s.style.opacity = 0; });
  };
  cardEl.addEventListener('pointerup', end);
  cardEl.addEventListener('pointercancel', end);
}

function decide(action) {
  const el = $('.swipe-card.is-top');
  const entry = deck[0];
  if (!el || !entry || el.dataset.leaving) return;
  el.dataset.leaving = '1';
  const out = { like: 'translate(130%, 0) rotate(14deg)', pass: 'translate(-130%, 0) rotate(-14deg)', super: 'translate(0, -120%)' }[action];
  $(`.stamp-${action === 'pass' ? 'nope' : action}`, el).style.opacity = 1;
  el.style.transition = 'transform .34s cubic-bezier(.4,0,.6,1), opacity .34s';
  el.style.transform = out;
  el.style.opacity = '0';
  const btn = $(`[data-act="swipe"][data-dir="${action}"]`);
  btn?.classList.add('pop');
  setTimeout(() => {
    applySwipe(entry.artwork, action);
    deck.shift();
    renderView();
  }, reducedMotion.matches ? 0 : 300);
}

function applySwipe(art, action) {
  setTimeout(maybeAskInterests, 450);
  setReaction(art, action);
  if (action === 'super' && !counts()) toast(`Saved “${art.title}” to your collection`);
}

// ——— Artwork & artist modals ———
function artworkSheet(id) {
  sheetArtworkId = id;
  const w = world.artworkById[id];
  const a = artistOf(w);
  const counts = world.countsOf(w);
  const rows = influenceBreakdown(counts);
  const max = Math.max(1, ...rows.map((r) => r.points));
  const globalRank = world.topArtworks().find((r) => r.item.id === id)?.rank;
  const countryRank = world.topArtworks({ country: a.country }).find((r) => r.item.id === id)?.rank;
  const catRank = world.topArtworks({ category: w.category }).find((r) => r.item.id === id)?.rank;
  const r = reactionOf(id);
  const avg = counts.reviews.count ? (counts.reviews.ratingSum / counts.reviews.count).toFixed(1) : '—';
  const myReview = state.reviews.find((x) => x.artworkId === id);
  const following = !!state.follows[a.id];
  return `<div class="detail-grid">
    <div class="detail-art">${ArtImage(w, { eager: true })}</div>
    <div class="detail-body">
      <p class="eyebrow">${esc(categoryById[w.category].label)} · ${esc(w.style)}</p>
      <h2 class="display-md" id="modal-title">${esc(w.title)}</h2>
      ${w.sample ? SampleNote('artwork') : ''}
      <div class="panel-artist">
        <button class="artist-line" data-act="artist" data-id="${a.id}">${Avatar(a, 'sm')}<span><b>${esc(a.name)}</b><small>${esc(countryName(a.country))}</small></span></button>
        ${a.isMe ? '' : `<button class="follow-btn${following ? ' is-on' : ''}" data-act="follow" data-id="${a.id}" aria-pressed="${following}">${following ? 'Following' : 'Follow'}</button>`}
      </div>
      ${w.description ? `<p class="artwork-description">${esc(w.description)}</p>` : ''}
      <dl class="spec">
        <div><dt>Medium</dt><dd>${esc(w.medium)}</dd></div>
        <div><dt>Year</dt><dd>${w.year}</dd></div>
        ${w.dimensions ? `<div><dt>Size</dt><dd>${esc(w.dimensions)}</dd></div>` : ''}
        ${w.editionSize ? `<div><dt>Edition</dt><dd>Prints, edition of ${w.editionSize} · ${Math.max(0, w.editionSize - (w.editionsSold || 0))} left</dd></div>` : ''}
        ${w.sample ? '' : `<div><dt>${forSale(w) ? 'Price' : 'Availability'}</dt><dd>${forSale(w) ? (w.availability === 'on_request' ? 'On request' : money(w.price)) : esc(AVAILABILITY[w.availability])}</dd></div>`}
      </dl>
      <div class="detail-actions">
        <button class="btn btn-icon${r === 'like' || r === 'super' ? ' is-on' : ''}" data-act="react" data-v="like" data-id="${id}" aria-pressed="${r === 'like' || r === 'super'}" aria-label="Admire">${Icon('admire', { size: 18 })}</button>
        <button class="btn btn-icon${r === 'super' ? ' is-on' : ''}" data-act="react" data-v="super" data-id="${id}" aria-pressed="${r === 'super'}" aria-label="Treasure">${Icon('treasure', { size: 18 })}</button>
        ${w.sample || !forSale(w) ? '' : PremiumButton(state.purchases.some((p) => p.artworkId === id) ? 'Purchased' : w.availability === 'on_request' ? 'Inquire' : `Inquire · ${money(w.price)}`, { act: 'buy', attrs: `data-id="${id}"` })}
        ${canBuy(w) ? PremiumButton(w.editionSize ? `Buy a print · ${money(w.price)}` : `Buy · ${money(w.price)}`, { act: 'checkout-buy', attrs: `data-id="${id}"` }) : ''}
        ${COMMUNITY && w.member && !isMine(w) && forSale(w) ? PremiumButton('Make an offer', { act: 'offer-open', variant: 'secondary', attrs: `data-id="${id}"` }) : ''}
        ${COMMUNITY && w.member && !isMine(w) && !forSale(w) ? PremiumButton(loop.watches.has(id) ? 'On your waitlist' : 'Notify me if available', { act: 'watch-toggle', variant: 'secondary', icon: 'bell', attrs: `data-id="${id}" aria-pressed="${loop.watches.has(id)}"` }) : ''}
        ${PremiumButton('Add to collection', { act: 'add-to-collection', variant: 'secondary', icon: 'folderPlus', attrs: `data-id="${id}"` })}
        ${state.user.role === 'critic' && !myReview ? PremiumButton('Review', { act: 'review', variant: 'secondary', icon: 'pen', attrs: `data-id="${id}"` }) : ''}
        ${isMine(w) && COMMUNITY ? PremiumButton('Edit', { act: 'edit-artwork', variant: 'secondary', icon: 'pen', attrs: `data-id="${id}"` }) : ''}
        ${isMine(w) ? PremiumButton('Delete', { act: 'delete-artwork', variant: 'ghost', attrs: `data-id="${id}" data-danger` }) : ''}
        ${IconButton('share', 'Share this artwork', { act: 'share-artwork', attrs: `data-id="${id}"` })}
        ${w.member && w.image ? IconButton('download', 'Share card for Instagram', { act: 'share-card', attrs: `data-id="${id}"` }) : ''}
      </div>
      ${myReview ? `<blockquote class="quote"><span class="stars-static">${'★'.repeat(myReview.rating)}${'☆'.repeat(5 - myReview.rating)}</span>${esc(myReview.text)}</blockquote>` : ''}
      <div class="stat-row">
        <div><b>${globalRank ?? '—'}</b><small>Worldwide</small></div>
        <div><b>${countryRank ?? '—'}</b><small>${esc(countryName(a.country))}</small></div>
        <div><b>${catRank ?? '—'}</b><small>${esc(categoryById[w.category].label)}</small></div>
        <div><b>${!COMMUNITY || state.community?.elo?.[w.id] != null ? Math.round(world.eloOf(w)) : '—'}</b><small>Battle Elo</small></div>
      </div>
      ${globalRank == null ? '<p class="fine">Not ranked yet: a work is ranked once members like or save it.</p>' : ''}
      <div class="influence">
        <div class="influence-head"><h3>Influence score</h3><span>${fmt(world.influence[id])}</span></div>
        ${rows.map((x) => `<div class="meter-row"><span>${esc(x.label)}</span><div class="meter"><i style="width:${(x.points / max) * 100}%"></i></div><span class="num">${fmt(x.points)}</span></div>
          <p class="meter-sub">${x.role === 'review' ? `${x.likes} reviews · average ${avg}★` : `${fmt(x.likes)} admirations · ${fmt(x.saves)} treasures · weight ×${ROLE_WEIGHTS[x.role]}`}</p>`).join('')}
      </div>
    </div>
  </div>`;
}

/** Member works can be marked sold or not for sale by their artist; sample works are never for sale. */
const forSale = (w) => !w.sample && (!w.availability || w.availability === 'available' || w.availability === 'on_request');

/** Every artwork has a shareable page: #art/<id>. */
function renderArtworkPage(root) {
  const id = route().param;
  if (!world.artworkById[id]) {
    root.innerHTML = `<div class="shell">${EmptyState({ title: 'Artwork not found', body: 'It may have been removed by the artist.', action: '<a class="btn btn-secondary" href="#explore"><span>Explore art</span></a>' })}</div>`;
    return;
  }
  trackArtwork('artwork_view', id);
  root.innerHTML = `<div class="shell artwork-page"><button class="link-arrow back-link" data-act="back">${Icon('back', { size: 14 })} Back</button>${artworkSheet(id)}</div>`;
}

/** Artists have their own page (#artist/<id>), so links and search results navigate there. */
function openArtist(id) {
  if (!world.artistById[id]) return;
  artistTab = 'artwork';
  const target = `artist/${encodeURIComponent(id)}`;
  if (location.hash.slice(1) === target) { closeSheet(); renderView(); } else location.hash = target;
}

function buySheet(id) {
  const w = world.artworkById[id];
  const a = artistOf(w);
  const b = checkoutBreakdown(w.price);
  const bought = state.purchases.some((p) => p.artworkId === id);
  return `<div class="buy">
    <header class="buy-head"><div class="buy-thumb">${ArtImage(w)}</div><div>
      <p class="eyebrow">Acquire</p><h2 class="display-sm" id="modal-title">${esc(w.title)}</h2><p class="muted">${esc(a.name)} · ${esc(w.medium)}</p></div></header>
    <table class="receipt">
      <tr><td>Artwork</td><td>${money(b.price)}</td></tr>
      <tr><td>Abremi commission (${(b.rate * 100).toFixed(1).replace('.0', '')}%)</td><td>${money(b.fee)}</td></tr>
      <tr class="total"><td>Artist receives</td><td>${money(b.artistPayout)}</td></tr>
    </table>
    <p class="fine">The commission slides from 10% to 5% as the price rises. Buyers pay the listed price.</p>
    <div class="detail-actions">${bought ? `<span class="tag tag-gold">${Icon('check', { size: 16 })} In your collection</span>` : PremiumButton(`Purchase · ${money(w.price)}`, { act: 'purchase', attrs: `data-id="${id}"`, size: 'lg' })}</div>
    <h3 class="sub-head">Or write to the artist</h3>
    <label class="field"><span class="sr-only">Message</span><textarea id="msg" rows="3" placeholder="Hi ${esc(a.name.split(' ')[0])}, I’d love to know more about “${esc(w.title)}”…"></textarea></label>
    <div class="detail-actions">${PremiumButton('Send inquiry', { act: 'send-message', variant: 'secondary', attrs: `data-id="${id}"` })}</div>
    <p class="fine">Prototype: no payment is taken and messages stay on this device.</p>
  </div>`;
}

function contactSheet(artistId) {
  const a = world.artistById[artistId];
  return `<div class="buy"><p class="eyebrow">Contact</p><h2 class="display-sm" id="modal-title">Write to ${esc(a.name)}</h2>
    <label class="field"><span class="sr-only">Message</span><textarea id="msg" rows="5" placeholder="Commission request, studio visit, collaboration…"></textarea></label>
    <div class="detail-actions">${PremiumButton('Send', { act: 'send-message', attrs: `data-artist="${artistId}"` })}</div>
    <p class="fine">Prototype: messages are stored on this device only.</p></div>`;
}

function reviewSheet(id) {
  const w = world.artworkById[id];
  return `<div class="buy"><p class="eyebrow">Critic review</p><h2 class="display-sm" id="modal-title">${esc(w.title)}</h2>
    <p class="muted">A 5★ critic review adds ${ROLE_WEIGHTS.critic * 2} influence, twice the weight of a critic's like.</p>
    <div class="stars" id="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button role="radio" aria-checked="false" data-act="star" data-n="${n}" aria-label="${n} stars">${Icon('star', { size: 28 })}</button>`).join('')}</div>
    <label class="field"><span class="sr-only">Review</span><textarea id="review-text" rows="4" placeholder="What makes this work matter?"></textarea></label>
    <div class="detail-actions">${PremiumButton('Publish review', { act: 'submit-review', attrs: `data-id="${id}"` })}</div></div>`;
}

function collectionSheet(kind) {
  const ids = collectionIds(kind);
  const titles = { saved: 'Treasures', liked: 'Admired works', purchased: 'Acquired' };
  return `<div><p class="eyebrow">Your collection</p><h2 class="display-md" id="modal-title">${titles[kind]}</h2>
    ${ids.length ? ArtworkGrid(ids.map((id) => card(world.artworkById[id])), { className: 'art-grid-tight' }) : EmptyState({ icon: 'bookmark', title: 'Nothing here yet', body: 'Save works from Discover to build your collection.' })}</div>`;
}

function userCollectionSheet(id) {
  const c = state.collections.find((x) => x.id === id);
  if (!c) return EmptyState({ title: 'Collection not found' });
  const works = c.ids.map((x) => world.artworkById[x]).filter(Boolean);
  return `<div class="user-collection"><p class="eyebrow">${c.private ? `${Icon('lock', { size: 12 })} Private collection` : c.server ? 'Shared collection' : 'Collection'} · ${c.server ? 'saved to your account' : 'on this device'}</p>
    <h2 class="display-md" id="modal-title">${esc(c.name)}</h2>
    ${c.description ? `<p class="muted">${esc(c.description)}</p>` : ''}
    <div class="detail-actions">
      ${PremiumButton(c.private ? 'Private' : c.server ? 'Shared: anyone with the link' : 'Not private', { act: 'collection-private', variant: 'secondary', icon: 'lock', attrs: `data-v="${c.id}" aria-pressed="${c.private}"` })}
      ${c.server && !c.private ? PremiumButton('Share link', { act: 'share-collection', variant: 'secondary', icon: 'share', attrs: `data-v="${c.id}"` }) : ''}
      ${c.server ? PremiumButton('Edit', { act: 'edit-collection', variant: 'ghost', icon: 'pen', attrs: `data-v="${c.id}"` }) : ''}
      ${PremiumButton('Delete collection', { act: 'collection-delete', variant: 'ghost', attrs: `data-v="${c.id}" data-danger` })}
    </div>
    ${works.length ? ArtworkGrid(works.map((w) => card(w)), { className: 'art-grid-tight' }) : EmptyState({ icon: 'folderPlus', title: 'Empty for now', body: 'Open any artwork and choose “Add to collection”.' })}</div>`;
}

let newCollectionFor = null;
let portraitChoice = null; // the portrait photo picked in the artist profile form
function newCollectionSheet() {
  return `<form class="auth" id="new-collection-form"><p class="eyebrow">New collection</p><h2 class="display-md" id="modal-title">Name your collection</h2>
    <div class="chip-row chip-row-wrap">${COLLECTION_PRESETS.map((p) => `<button type="button" class="chip" data-act="collection-preset" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <label class="field"><span>Name</span><input id="collection-name" maxlength="60" autocomplete="off" placeholder="Personal Museum"></label>
    <label class="check"><input type="checkbox" id="collection-private" checked> Private</label>
    <div class="detail-actions">${PremiumButton('Create collection', { act: 'collection-create' })}</div>
    <p class="fine">${syncedCollections() ? 'Saved to your account. Private collections are visible only to you; shared ones to anyone with the link.' : COMMUNITY ? 'Saved on this device. Sign in to keep your collections with your account.' : 'Collections are saved on this device.'}</p></form>`;
}

function addToCollectionSheet(artworkId) {
  const w = world.artworkById[artworkId];
  return `<div class="auth"><p class="eyebrow">Add to collection</p><h2 class="display-sm" id="modal-title">${esc(w?.title || '')}</h2>
    ${state.collections.length ? `<ul class="pick-list">${state.collections.map((c) => {
      const inIt = c.ids.includes(artworkId);
      return `<li><button class="pick${inIt ? ' is-on' : ''}" data-act="collection-toggle" data-v="${c.id}" data-id="${artworkId}" aria-pressed="${inIt}">
        <span>${c.private ? Icon('lock', { size: 14 }) : ''} ${esc(c.name)}</span><small>${c.ids.length} works</small>${inIt ? Icon('check', { size: 18 }) : Icon('plus', { size: 18 })}</button></li>`;
    }).join('')}</ul>` : '<p class="muted">You have no collections yet.</p>'}
    <div class="detail-actions">${PremiumButton('New collection', { act: 'new-collection', variant: 'secondary', icon: 'plus', attrs: `data-id="${artworkId}"` })}</div></div>`;
}

function collectionIds(kind) {
  const by = (v) => Object.entries(state.interactions).filter(([, x]) => x === v).map(([k]) => k).filter((id) => world.artworkById[id]);
  if (kind === 'saved') return by('super');
  if (kind === 'liked') return by('like');
  return [...new Set(state.purchases.map((p) => p.artworkId))].filter((id) => world.artworkById[id]);
}

// ——— Battles ———
function newBattle() {
  battlePair = pickBattlePair(catalog(), rng);
  battleOutcome = null;
}

function battleArenaHTML(compact = false) {
  if (!battlePair) newBattle();
  const cards = battlePair.map((w, i) => {
    let result = null;
    if (battleOutcome) {
      const won = battleOutcome.winner === i;
      result = {
        state: won ? 'won' : 'lost',
        delta: won ? `+${battleOutcome.res.gain}` : `−${battleOutcome.res.loss}`,
        share: won ? battleOutcome.crowd : 100 - battleOutcome.crowd,
      };
    }
    return ArtBattleCard(w, { artist: artistOf(w), index: i, elo: world.eloOf(w), result });
  });
  return BattleArena(cards, { compact });
}

// ——— Artist Arena: Battles, Competitions and History ———
const arena = { tab: 'battles', list: null, at: 0, details: new Map(), adminKind: 'weekly' };
async function loadArena(force = false) {
  if (!cloud?.arena || (!force && Date.now() - arena.at < 15_000)) return;
  arena.at = Date.now();
  try { arena.list = await cloud.arena(); } catch { arena.list ||= []; }
  // A competition that moved on (entries → voting → results) is fetched again when opened.
  for (const c of arena.list) if (arena.details.get(c.id)?.data && arena.details.get(c.id).data.phase !== c.phase) arena.details.delete(c.id);
  // Only the Arena tab redraws here; the moderator page redraws when its own data loads (so a
  // background refresh never wipes a form someone is filling in).
  if (currentView() === 'battle' && !sheetRenderer && !document.activeElement?.matches('input, textarea, select')) renderView();
}
const coverThumb = (id) => (world.artworkById[id] ? ArtImage(world.artworkById[id]) : '');

function renderBattle(root) {
  if (arena.tab !== 'battles') {
    if (COMMUNITY && !arena.list) loadArena(true);
    root.innerHTML = `<div class="shell battle arena-view">
      <header class="battle-head"><h1 class="display-md">${Icon('trophy', { size: 26 })} Artist Arena</h1>
        <p class="lede">${arena.tab === 'history' ? 'Past competitions and their winners.' : 'Daily, weekly and themed competitions. One entry per artist, one vote per member.'}</p></header>
      ${arenaTabs(arena.tab)}
      ${arena.tab === 'history' ? historyHTML(arena.list, { cover: coverThumb }) : competitionsHTML(arena.list, { cover: coverThumb, signedIn: Boolean(me), demo: !COMMUNITY })}
    </div>`;
    return;
  }
  if (!battlePair) newBattle();
  const history = (state.battles.history || []).slice(0, 6).filter((h) => world.artworkById[h.w] && world.artworkById[h.l]);
  root.innerHTML = `<div class="shell battle">
    <header class="battle-head">
      <h1 class="display-md">${Icon('trophy', { size: 26 })} Art Battle</h1>
      <p class="lede">Vote for your favourite masterpiece.</p>
      ${arenaTabs('battles')}
      <dl class="inline-stats">
        <div><dt>Your votes</dt><dd>${state.battles.voted}</dd></div>
        <div><dt>Crowd streak</dt><dd>${state.battles.streak}</dd></div>
        <div><dt>Vote weight</dt><dd>K ${kFactor(state.user.role)}</dd></div>
      </dl>
    </header>
    ${battleArenaHTML()}
    <p class="fine center">Winners gain rating; losers drop only ${LOSS_FACTOR * 100}% as much. Keys: ← and →.</p>
    ${history.length ? `<section class="section section-tight battle-history">
      ${SectionHeader({ eyebrow: 'Your votes', title: 'Recent battles' })}
      <ol class="rank-list">${history.map((h) => {
        const w = world.artworkById[h.w], l = world.artworkById[h.l];
        return `<li><button class="rank-row" data-act="artwork" data-id="${w.id}"><span class="rank-thumb">${ArtImage(w)}</span>
          <span class="rank-text"><b>${esc(w.title)}</b><small>beat ${esc(l.title)} · ${new Date(h.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span>
          <span class="rank-score"><span class="move move-up">+${h.gain}</span></span></button></li>`;
      }).join('')}</ol>
    </section>` : ''}
  </div>`;
}

// ——— Collector Radar and Drops (community mode) ———
const radar = { list: null, tab: 'received', drops: null, dropsAt: 0, scheduled: [], inquiryFor: null };
async function loadInbox() {
  if (!cloud?.inquiries || !me) return;
  try { radar.list = await cloud.inquiries(); } catch { return; }
  if (currentView() === 'inbox' && !sheetRenderer) renderView();
  else { const m = $('#menu-inbox'); const n = radar.list.filter((q) => q.unread).length; if (m) m.textContent = n ? `Inbox (${n})` : 'Inbox'; }
}
// ——— Founding artists (chosen by moderators; editorial, never ranked) ———
const founding = { ids: [], at: 0 };
async function loadFounding(force = false) {
  if (!cloud?.foundingArtists || (!force && Date.now() - founding.at < 60_000)) return;
  founding.at = Date.now();
  try { founding.ids = (await cloud.foundingArtists()).map((f) => f.artist_id); } catch { return; }
  if (['home', 'artist', 'join'].includes(currentView()) && !sheetRenderer && !document.activeElement?.matches('input, textarea, select')) renderView();
}
const isFounding = (id) => founding.ids.includes(id);
function foundingHTML() {
  if (!COMMUNITY) return '';
  loadFounding();
  const artists = founding.ids.map((id) => world.artistById[id]).filter(Boolean);
  if (!artists.length) return '';
  return `<section class="section founding">
    ${SectionHeader({ eyebrow: 'Chosen by Abremi', title: 'Founding artists', action: `<a class="link-arrow" href="#join">Become one ${Icon('arrow', { size: 16 })}</a>` })}
    <p class="muted founding-note">The first artists to show their work on Abremi. Chosen by our team, not ranked: their place in the rankings comes from admirations, like everyone’s.</p>
    <div class="artist-grid">${artists.map((a) => ArtistCard(a, { cover: coverOf(a.id), following: !!state.follows[a.id], rank: world.globalArtistRanks[a.id], signals: signalChips(a.id) })).join('')}</div>
  </section>`;
}

async function loadDrops(force = false) {
  if (!cloud?.drops || (!force && Date.now() - radar.dropsAt < 30_000)) return;
  radar.dropsAt = Date.now();
  try {
    const [list, scheduled] = await Promise.all([cloud.drops(), me && cloud.scheduledWorks ? cloud.scheduledWorks() : []]);
    radar.drops = list; radar.scheduled = scheduled || [];
  } catch { radar.drops ||= []; }
  if (currentView() === 'home' && !sheetRenderer && !document.activeElement?.matches('input, textarea, select')) renderView();
}
const storageImage = (path) => imageURL(path, cloud?.storageBase || '');
/** A card for a drop's work: from the catalog once released, or the artist's own scheduled copy. */
function dropWorkCard(id) {
  const w = world.artworkById[id];
  if (w) return card(w);
  const x = radar.scheduled.find((s) => s.id === id);
  return x ? `<article class="art-card is-scheduled"><div class="art-frame"><img src="${esc(storageImage(x.thumb_path))}" alt="" loading="lazy"></div>
    <div class="art-caption"><div class="art-caption-main"><h3 class="art-title">${esc(x.title)}</h3><p class="art-meta">Scheduled · only you can see it</p></div></div></article>` : '';
}

/** Open the inquiry form for a work or an artist (community mode). */
function openInquiry({ artworkId = null, artistId = null, kind }) {
  if (!me) return openSignIn();
  const w = artworkId ? world.artworkById[artworkId] : null;
  const a = w ? artistOf(w) : world.artistById[artistId];
  if (!a || a.sample || w?.sample) return toast('Sample works and artists can’t be contacted.');
  if (a.isMe) return toast('That’s your own work.');
  radar.inquiryFor = { artworkId: w?.id || null, artistId: a.id };
  openSheet(() => inquirySheet({ artwork: w ? { id: w.id, title: w.title, available: forSale(w) } : null, artist: { id: a.id, name: a.name },
    kind: kind || (w && forSale(w) ? 'purchase' : w ? 'question' : 'commission'), thumb: w ? `<span class="rank-thumb">${ArtImage(w)}</span>` : '' }));
}

function renderInbox(root) {
  if (!COMMUNITY || !me) { root.innerHTML = `<div class="shell">${EmptyState({ icon: 'mail', title: COMMUNITY ? 'Sign in to see your inbox' : 'Inquiries run with accounts', action: COMMUNITY ? PremiumButton('Sign in', { act: 'sign-in' }) : '' })}</div>`; return; }
  if (radar.list == null) loadInbox();
  root.innerHTML = inboxPage(radar.list, { tab: radar.tab, thumb: (id) => (world.artworkById[id] ? ArtImage(world.artworkById[id]) : ''), title: (id) => world.artworkById[id]?.title || 'A work' });
}

const threads = new Map();
function renderInquiry(root) {
  const id = route().param;
  if (!COMMUNITY || !me) { renderInbox(root); return; }
  const entry = threads.get(id);
  if (cloud && (!entry || (!entry.loading && Date.now() - entry.at > 10_000))) {
    threads.set(id, { loading: true, data: entry?.data });
    Promise.all([cloud.inquiryThread(id), cloud.inquiryOffer ? cloud.inquiryOffer(id).catch(() => null) : null])
      .then(([data, offer]) => { if (data && offer) data.offer = offer; threads.set(id, { data, at: Date.now() }); if (data) cloud.markInquiryRead(id).then(loadInbox).catch(() => {}); })
      .catch(() => threads.set(id, { data: entry?.data || null, at: Date.now() }))
      .finally(() => { if (route().name === 'inquiry' && route().param === id && !sheetRenderer && !document.activeElement?.matches('textarea')) renderView(); });
  }
  const d = threads.get(id)?.data;
  if (d === undefined) { root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 3, variant: 'list' })}</div>`; return; }
  if (!d) { root.innerHTML = `<div class="shell">${EmptyState({ icon: 'mail', title: 'Conversation not found', action: '<a class="btn btn-secondary" href="#inbox"><span>Inbox</span></a>' })}</div>`; return; }
  root.innerHTML = threadPage(d, { thumb: (aid) => (world.artworkById[aid] ? ArtImage(world.artworkById[aid]) : ''), title: (aid) => world.artworkById[aid]?.title || 'A work' });
}

const dropDetails = new Map();
function renderDrop(root) {
  const id = route().param;
  if (!COMMUNITY) { root.innerHTML = `<div class="shell">${EmptyState({ title: 'Drops run with accounts' })}</div>`; return; }
  const entry = dropDetails.get(id);
  if (cloud && (!entry || (!entry.loading && Date.now() - entry.at > 15_000))) {
    dropDetails.set(id, { loading: true, data: entry?.data });
    Promise.all([cloud.drop(id), me && cloud.scheduledWorks ? cloud.scheduledWorks() : radar.scheduled])
      .then(([data, scheduled]) => { radar.scheduled = scheduled || []; dropDetails.set(id, { data, at: Date.now() }); })
      .catch(() => dropDetails.set(id, { data: entry?.data || null, at: Date.now() }))
      .finally(() => { if (route().name === 'drop' && route().param === id && !sheetRenderer) renderView(); });
  }
  const d = dropDetails.get(id)?.data;
  if (d === undefined) { root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 3 })}</div>`; return; }
  if (!d) { root.innerHTML = `<div class="shell">${EmptyState({ title: 'Drop not found', action: '<a class="btn btn-secondary" href="#home"><span>Home</span></a>' })}</div>`; return; }
  root.innerHTML = dropPage(d, { image: storageImage, card: dropWorkCard, signedIn: Boolean(me) });
}

// ——— Career Coach, Artist Passport and Opportunities (community mode) ———
const careers = { coach: { tool: 'bio', artworkId: null, opportunityId: null, busy: false, result: null, error: '' }, usage: null,
  opps: null, oppsAt: 0, oppKind: '', passports: new Map(), exhibitions: null };
async function loadOpportunities(force = false) {
  if (!cloud?.opportunities || (!force && careers.opps && Date.now() - careers.oppsAt < 60_000)) return;
  careers.oppsAt = Date.now();
  try { careers.opps = await cloud.opportunities(); } catch { careers.opps ||= []; }
  if (['opportunities', 'coach'].includes(currentView()) && !sheetRenderer) renderView();
}
const myMemberWorks = () => (world.worksByArtist[myArtistId()] || []).filter((w) => w.member);

function renderCoach(root) {
  if (!COMMUNITY || !me) { root.innerHTML = `<div class="shell">${EmptyState({ icon: 'pen', title: COMMUNITY ? 'Sign in to use the Coach' : 'The Coach runs with accounts', action: COMMUNITY ? PremiumButton('Sign in', { act: 'sign-in' }) : '' })}</div>`; return; }
  if (!world.artistById[myArtistId()]) { root.innerHTML = `<div class="shell">${EmptyState({ icon: 'pen', title: 'The Coach is for artists', body: 'Publish a work from Profile → Studio first.', action: '<a class="btn btn-secondary" href="#profile"><span>Studio</span></a>' })}</div>`; return; }
  if (!careers.usage && cloud?.coachUsage) cloud.coachUsage().then((u) => { careers.usage = u; if (currentView() === 'coach') renderView(); }).catch(() => {});
  if (!careers.opps) loadOpportunities();
  const works = myMemberWorks().map((w) => ({ id: w.id, title: w.title }));
  const c = careers.coach;
  c.artworkId ||= works[0]?.id || null;
  c.opportunityId ||= careers.opps?.[0]?.id || null;
  const v = lazyPage(root, 'careers');
  if (!v) return;
  root.innerHTML = v.coachPage({ state: c, usage: careers.usage, works, opportunities: (careers.opps || []).map((o) => ({ id: o.id, title: o.title })) });
}

function renderOpportunities(root) {
  if (!COMMUNITY) { root.innerHTML = `<div class="shell">${EmptyState({ title: 'Opportunities run with accounts' })}</div>`; return; }
  loadOpportunities();
  const v = lazyPage(root, 'careers');
  if (!v) return;
  root.innerHTML = v.opportunitiesPage(careers.opps, { kind: careers.oppKind, signedIn: Boolean(me), artist: Boolean(me && world.artistById[myArtistId()]) });
}

/** The Passport tab on a member artist's page (fetched when opened). */
function passportTabHTML(id) {
  const entry = careers.passports.get(id);
  if (cloud?.passport && (!entry || (!entry.loading && Date.now() - entry.at > 60_000))) {
    careers.passports.set(id, { loading: true, data: entry?.data });
    cloud.passport(id).then((data) => careers.passports.set(id, { data, at: Date.now() }))
      .catch(() => careers.passports.set(id, { data: entry?.data ?? null, at: Date.now() }))
      .finally(() => { if (route().name === 'artist' && route().param === id && artistTab === 'passport' && !sheetRenderer) renderView(); });
  }
  const data = careers.passports.get(id)?.data;
  const v = lazyView('careers');
  return data === undefined || !v ? LoadingSkeleton({ cards: 3, variant: 'list' }) : v.passportHTML(data, { artworkTitle: (aid) => world.artworkById[aid]?.title || 'A work' });
}

/**
 * Nine colours sampled from a drop's teaser image (a 3×3 grid). Until release, the drop page paints a
 * soft veil from these instead of the image, so the work itself can't be seen early.
 */
async function teaserPalette(src) {
  if (!src) return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = src; });
  const c = document.createElement('canvas');
  c.width = 3; c.height = 3;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 3, 3);
  const d = g.getImageData(0, 0, 3, 3).data;
  return Array.from({ length: 9 }, (_, i) => `#${[d[i * 4], d[i * 4 + 1], d[i * 4 + 2]].map((x) => x.toString(16).padStart(2, '0')).join('')}`).join(',');
}

// ——— Phase 6: plans, gallery accounts, beta tools ———
// What a member's plan includes is decided by the database; this only shows it.
const member = { flags: null, mine: undefined, gallery: undefined, badges: {}, busy: '', planSearch: { query: '', results: null }, feedbackKind: 'bug', galleries: new Map() };
async function loadMembership() {
  if (!cloud?.appFlags) return;
  const [flags, mine, gallery, badges] = await Promise.all([
    cloud.appFlags().catch(() => member.flags),
    me ? cloud.myPlan().catch(() => member.mine ?? null) : null,
    me ? cloud.myGallery().catch(() => member.gallery ?? null) : null,
    cloud.planBadges().catch(() => member.badges),
  ]);
  Object.assign(member, { flags, mine, gallery, badges: badges || {} });
}

function renderPlans(root) {
  if (COMMUNITY && member.mine === undefined && cloud) {
    member.mine = null;
    loadMembership().finally(() => { if (currentView() === 'plans' && !sheetRenderer) renderView(); });
  }
  root.innerHTML = plansPage({ community: COMMUNITY, signedIn: Boolean(me), mine: member.mine, payments: Boolean(member.flags?.payments_enabled), gallery: member.gallery, busy: member.busy });
}

function renderGallery(root) {
  const id = route().param;
  const entry = member.galleries.get(id);
  if (!COMMUNITY) { root.innerHTML = `<div class="shell">${EmptyState({ title: 'Galleries run with accounts' })}</div>`; return; }
  if (cloud && (!entry || (!entry.loading && Date.now() - entry.at > 60_000))) {
    member.galleries.set(id, { loading: true, data: entry?.data });
    cloud.galleryPage(id).then((data) => member.galleries.set(id, { data, at: Date.now() }))
      .catch(() => member.galleries.set(id, { data: entry?.data ?? null, at: Date.now() }))
      .finally(() => { if (route().name === 'gallery' && route().param === id && !sheetRenderer) renderView(); });
  }
  const data = member.galleries.get(id)?.data;
  root.innerHTML = data === undefined ? `<div class="shell">${LoadingSkeleton({ cards: 3, variant: 'list' })}</div>`
    : galleryPageHTML(data, { signedIn: Boolean(me), artist: Boolean(me && world.artistById[myArtistId()]) });
}

/** App errors go to the moderators' error log (no account or personal data), at most 5 per visit. */
let errorsSent = 0;
const errorsSeen = new Set();
function reportError(message, source) {
  if (!cloud?.logError || errorsSent >= 5) return;
  const key = `${message}|${source}`;
  if (!message || errorsSeen.has(key)) return;
  errorsSeen.add(key);
  errorsSent++;
  cloud.logError({ message: String(message).slice(0, 500), source: source ? String(source).replace(location.origin, '').slice(0, 300) : null, page: `#${location.hash.slice(1).split('?')[0]}` }).catch(() => {});
}
window.addEventListener('error', (e) => reportError(e.message, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason?.message || String(e.reason), e.reason?.stack?.split('\n')[1]?.trim()));

// ——— Beta launch kit: welcome, tour, #join, share cards ———
const welcomed = () => { try { return Boolean(localStorage.getItem(WELCOME_KEY)); } catch { return true; } };
const markWelcomed = () => { try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* private mode */ } };
let tourStep = 0;

function renderJoin(root) {
  root.innerHTML = joinPage({ community: COMMUNITY, signedIn: Boolean(me), isArtist: state.user.role === 'artist' || Boolean(world.artistById[myArtistId()]), salesOn: Boolean(member.flags?.sales_enabled) });
}

/** A 1080×1350 card (Instagram portrait) of a member's work with its title, artist and the Abremi mark. */
async function shareCard(w) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = w.image; });
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1350;
  const g = c.getContext('2d');
  g.fillStyle = '#0b0c0d'; g.fillRect(0, 0, c.width, c.height);
  const box = { x: 90, y: 90, w: 900, h: 930 };
  const scale = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight);
  const iw = img.naturalWidth * scale, ih = img.naturalHeight * scale;
  g.drawImage(img, box.x + (box.w - iw) / 2, box.y + (box.h - ih) / 2, iw, ih);
  g.strokeStyle = 'rgba(214,173,104,.55)'; g.lineWidth = 2; g.strokeRect(60, 60, 960, 1230);
  g.fillStyle = '#f3efe7'; g.font = '500 54px "Playfair Display", Georgia, serif';
  g.fillText(w.title.length > 30 ? `${w.title.slice(0, 29)}…` : w.title, 90, 1110, 900);
  g.fillStyle = '#b9b3a8'; g.font = '400 32px Inter, Helvetica, Arial, sans-serif';
  g.fillText(artistOf(w)?.name || '', 90, 1162, 900);
  g.fillStyle = '#d6ad68'; g.font = '500 24px Inter, Helvetica, Arial, sans-serif';
  g.fillText(`ON ABREMI  ·  ${location.host}`.toUpperCase(), 90, 1236, 900);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}

// ——— Checkout and orders (#orders) ———
// Buying is shown only when sales are switched on and the artist can be paid (both checked again
// by the database). Payment happens on Stripe; Abremi never holds artists' money.
const sales = { accepting: new Set(), editions: new Map(), payout: null, orders: null, busy: '' };
async function loadSales() {
  if (!cloud?.salesCatalog || !member.flags?.sales_enabled) return;
  const c = await cloud.salesCatalog().catch(() => null);
  if (!c) return;
  sales.accepting = new Set(c.accepting);
  sales.editions = new Map(c.editions.map((e) => [e.id, e]));
  for (const [id, e] of sales.editions) if (world.artworkById[id]) Object.assign(world.artworkById[id], { editionSize: e.edition_size, editionsSold: e.editions_sold });
}
function canBuy(w) {
  return COMMUNITY && Boolean(member.flags?.sales_enabled) && w.member && !isMine(w) && sales.accepting.has(w.artistId)
    && (w.availability || 'available') === 'available' && w.price > 0;
}
function renderOrders(root) {
  if (!COMMUNITY || !me) { root.innerHTML = `<div class="shell">${EmptyState({ icon: 'lock', title: 'Sign in to see your orders', action: COMMUNITY ? PremiumButton('Sign in', { act: 'sign-in' }) : '' })}</div>`; return; }
  if (/paid=1/.test(location.hash) && !sales.thanked) { sales.thanked = true; toast('Payment received. The artist will ship your work and add tracking here.', { force: true, duration: 5000 }); }
  if (sales.orders === null && cloud?.myOrders) {
    sales.orders = undefined;
    Promise.all([cloud.myOrders(), cloud.myPayoutStatus().catch(() => null)])
      .then(([orders, payout]) => Object.assign(sales, { orders, payout }))
      .catch(() => Object.assign(sales, { orders: { sales: [], purchases: [] } }))
      .finally(() => { if (currentView() === 'orders' && !sheetRenderer) renderView(); });
  }
  if (!sales.orders) { root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 3, variant: 'list' })}</div>`; return; }
  const v = lazyPage(root, 'orders');
  if (!v) return;
  root.innerHTML = v.ordersPage(sales.orders, { payout: sales.payout, isArtist: Boolean(world.artistById[myArtistId()]), salesOn: Boolean(member.flags?.sales_enabled), busy: sales.busy, country: state.user.country || 'US' });
}

// ——— The Abremi Index (#index) ———
const idx = { week: null, chart: 'overall', cache: new Map(), badge: undefined };
function renderIndex(root) {
  if (!COMMUNITY) { root.innerHTML = `<div class="shell">${EmptyState({ icon: 'chart', title: 'The Abremi Index runs with accounts', body: 'It charts real members’ appreciation, week by week.' })}</div>`; return; }
  const key = `${idx.week || 'latest'}|${idx.chart}`;
  const entry = idx.cache.get(key);
  if (cloud?.indexWeek && (!entry || (!entry.loading && Date.now() - entry.at > 300_000))) {
    idx.cache.set(key, { loading: true, data: entry?.data });
    cloud.indexWeek(idx.week, idx.chart).then((data) => idx.cache.set(key, { data, at: Date.now() }))
      .catch(() => idx.cache.set(key, { data: entry?.data ?? null, at: Date.now() }))
      .finally(() => { if (currentView() === 'index' && !sheetRenderer) renderView(); });
  }
  const d = idx.cache.get(key)?.data;
  if (d === undefined) { root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 6, variant: 'list' })}</div>`; return; }
  const v = lazyPage(root, 'index');
  if (!v) return;
  root.innerHTML = v.indexPage(d, { thumb: (id) => (world.artworkById[id] ? ArtImage(world.artworkById[id]) : '') });
  $('#index-week', root)?.addEventListener('change', (e) => { idx.week = e.target.value; renderView(); });
  $('#index-chart', root)?.addEventListener('change', (e) => { idx.chart = e.target.value; renderView(); });
}

// ——— Phase 8: the discovery-to-ownership loop ———
const loop = { watches: new Set(), interests: null, swipes: 0, loaded: false };
const INTEREST_PROMPT_KEY = 'abremi:interests-prompted';

async function loadLoop() {
  if (!cloud?.myWatches || !me) return;
  const [watches, mine] = await Promise.all([cloud.myWatches().catch(() => []), cloud.myInterests().catch(() => null)]);
  Object.assign(loop, { watches: new Set(watches || []), interests: mine?.interests || {}, loaded: true });
}

/** A price you can act on: in community mode, only members' works that are available (sample prices aren't real). */
function listedPrice(w) {
  if (!COMMUNITY) return w.price;
  return w.member && w.price > 0 && (!w.availability || w.availability === 'available') ? w.price : null;
}

function interestPool(pool) {
  const i = loop.interests || {};
  const mediums = new Set(i.mediums || []);
  const regions = new Set(i.regions || []);
  if (!mediums.size && !regions.size && !i.price_max) return [];
  return pool.filter((w) => (!mediums.size || mediums.has(w.category))
    && (!regions.size || regions.has(artistOf(w)?.country))
    && (!i.price_max || listedPrice(w) == null || listedPrice(w) <= i.price_max));
}

/** After a few swipes, offer (once) to tailor Discover. Optional, and easy to skip. */
function maybeAskInterests() {
  if (!COMMUNITY || !me || !loop.loaded || sheetRenderer || ++loop.swipes < 8) return;
  const i = loop.interests || {};
  if ((i.mediums || []).length || (i.regions || []).length || i.price_max) return;
  try { if (localStorage.getItem(INTEREST_PROMPT_KEY)) return; localStorage.setItem(INTEREST_PROMPT_KEY, '1'); } catch { return; }
  openSheet(interestsSheet);
}

function interestsSheet() {
  const i = loop.interests || {};
  const mediums = new Set(i.mediums || []);
  const regions = new Set(i.regions || []);
  const counts = {};
  for (const w of catalog()) { const c = artistOf(w)?.country; if (c) counts[c] = (counts[c] || 0) + 1; }
  const topRegions = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c]) => c);
  if (state.user.country && !topRegions.includes(state.user.country)) topRegions.unshift(state.user.country);
  const chip = (act, v, label, on) => `<button type="button" class="chip${on ? ' is-on' : ''}" data-act="${act}" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;
  return `<form class="sheet-form" id="interests-form" onsubmit="return false">
    <p class="eyebrow">Your taste</p><h2 class="display-md" id="modal-title">What would you like to see more of?</h2>
    <p class="muted">Optional. It shapes your own Discover and the Guide’s suggestions, never the rankings, and you can change it any time from Profile.</p>
    <h3 class="sub-head">Mediums</h3>
    <div class="chip-row chip-row-wrap">${Object.entries(DISCOVER_LABELS).map(([k, v]) => chip('interest-toggle', k, v, mediums.has(k))).join('')}</div>
    <h3 class="sub-head">Where artists are from</h3>
    <div class="chip-row chip-row-wrap">${topRegions.map((c) => chip('interest-toggle', c, `${flag(c)} ${countryName(c) || c}`, regions.has(c))).join('')}</div>
    <label class="field"><span>Price limit for works for sale</span><select id="interest-price">
      ${[['', 'Any price'], ['250', 'Up to $250'], ['500', 'Up to $500'], ['1000', 'Up to $1,000'], ['2500', 'Up to $2,500'], ['5000', 'Up to $5,000'], ['10000', 'Up to $10,000']]
        .map(([v, l]) => `<option value="${v}"${String(i.price_max || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="detail-actions">${PremiumButton('Save', { act: 'interests-save' })}${PremiumButton('Not now', { act: 'close-sheet', variant: 'ghost' })}</div>
  </form>`;
}

/** New on Abremi: artists who joined in the last 60 days, one recent work each, in a fair daily rotation. */
function emergingHTML() {
  if (!COMMUNITY) return '';
  const cutoff = Date.now() - 60 * 864e5;
  const day = dayKey();
  const picks = world.artists.filter((a) => a.member && a.joinedAt > cutoff && !a.isMe)
    .map((a) => ({ a, w: catalog().filter((x) => x.artistId === a.id).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))[0] }))
    .filter((x) => x.w)
    .sort((x, y) => hashString(`${day}:${x.a.id}`) - hashString(`${day}:${y.a.id}`))
    .slice(0, 8);
  if (!picks.length) return '';
  return `<section class="section" id="emerging">
    ${SectionHeader({ eyebrow: 'New on Abremi', title: 'Emerging artists' })}
    <p class="muted emerging-note">Artists who joined in the last 60 days, one work each, in a fair daily rotation, not ordered by popularity.</p>
    ${ArtworkGrid(picks.map(({ w }) => card(w)))}
  </section>`;
}

// ——— Phase 7: the Abremi Guide ———
// One assistant, three modes. Conversations live only in this tab's memory (never saved); the
// server decides what the Guide may see and counts only that a request happened.
let sheetArtworkId = null;
const guide = {
  open: false, mode: 'visitor', view: 'chat', threads: { visitor: [], artist: [], collector: [] },
  busy: false, error: null, input: '', usage: null, prefs: null, prefsBusy: false, pendingAdd: null, loaded: false,
};

/** What the member is looking at, for the Guide (the server looks up the details itself). */
function guidePage() {
  if (sheetArtworkId) return { type: 'artwork', id: sheetArtworkId };
  const r = route();
  if (r.name === 'art' && r.param) return { type: 'artwork', id: r.param };
  if (r.name === 'artist' && r.param) return { type: 'artist', id: r.param };
  if (r.name === 'collection' && r.param) return { type: 'collection', id: r.param };
  if (r.name === 'competition' && r.param) return { type: 'competition', id: r.param };
  if (r.name === 'charts') return { type: 'ranking', id: charts.tab || 'artworks' };
  if (r.name === 'battle' && battlePair) return { type: 'battle', id: battlePair.map((w) => w.id).join(',') };
  return null;
}

function guideEvent(kind, target) {
  if (cloud?.guideEvent && me) cloud.guideEvent(kind, target).catch(() => {});
}

function guideRef(ref, reason) {
  const why = reason ? `<p class="guide-why">${esc(reason)}</p>` : '';
  if (ref.type === 'artwork') {
    const w = world.artworkById[ref.id];
    if (!w) return '';
    const a = artistOf(w);
    return `<article class="guide-card" data-guide-ref="artwork" data-id="${esc(w.id)}">
      <button class="guide-card-art" data-act="artwork" data-id="${esc(w.id)}" aria-label="View ${esc(w.title)}">${ArtImage(w)}</button>
      <div class="guide-card-body"><b>${esc(w.title)}</b><small>${esc(a?.name || '')}${w.style ? ` · ${esc(w.style)}` : ''}</small>${why}
        <div class="guide-card-actions"><button class="link" data-act="artwork" data-id="${esc(w.id)}">${esc(GUIDE_COPY.view)}</button>
        ${me ? `<button class="link" data-act="add-to-collection" data-id="${esc(w.id)}">${esc(GUIDE_COPY.save)}</button>` : ''}</div></div></article>`;
  }
  if (ref.type === 'artist') {
    const a = world.artistById[ref.id];
    if (!a) return '';
    const following = Boolean(state.follows[a.id]);
    return `<article class="guide-card" data-guide-ref="artist" data-id="${esc(a.id)}">
      <button class="guide-card-avatar" data-act="artist" data-id="${esc(a.id)}" aria-label="Open ${esc(a.name)}">${Avatar(a, 'md')}</button>
      <div class="guide-card-body"><b>${esc(a.name)}</b><small>${esc(countryName(a.country))}${a.sample ? ' · sample artist' : ''}</small>${why}
        <div class="guide-card-actions"><button class="link" data-act="artist" data-id="${esc(a.id)}">${esc(GUIDE_COPY.view)}</button>
        ${a.isMe ? '' : `<button class="link" data-act="follow" data-id="${esc(a.id)}" aria-pressed="${following}">${esc(following ? GUIDE_COPY.following : GUIDE_COPY.follow)}</button>`}</div></div></article>`;
  }
  return `<div class="guide-search-row"><button class="chip" data-act="guide-search" data-v="${esc(ref.id)}">${Icon('search', { size: 14 })} ${esc(ref.id)}</button>${reason ? `<small>${esc(reason)}</small>` : ''}</div>`;
}

function guideInlineRef(ref) {
  if (ref.type === 'artwork' && world.artworkById[ref.id]) return `<button class="link" data-act="artwork" data-id="${esc(ref.id)}">${esc(world.artworkById[ref.id].title)}</button>`;
  if (ref.type === 'artist' && world.artistById[ref.id]) return `<button class="link" data-act="artist" data-id="${esc(ref.id)}">${esc(world.artistById[ref.id].name)}</button>`;
  if (ref.type === 'search') return `<button class="link" data-act="guide-search" data-v="${esc(ref.id)}">${esc(ref.id)}</button>`;
  return '';
}

function renderGuide() {
  const panel = $('#guide');
  const launcher = $('#guide-launcher');
  if (!panel || !launcher) return;
  if (!launcher.dataset.ready) { launcher.innerHTML = `${Icon('spark', { size: 18 })}<span>${esc(GUIDE_COPY.launcher)}</span>`; launcher.dataset.ready = '1'; }
  launcher.hidden = !COMMUNITY || guide.open || currentView() === 'discover';
  if (!guide.open) { panel.hidden = true; return; }
  const input = $('#guide-input');
  const hadFocus = input && document.activeElement === input;
  if (input) guide.input = input.value;
  const log = $('.guide-log', panel);
  const nearBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  panel.hidden = false;
  panel.innerHTML = guidePanelHTML({ ...guide, thread: guide.threads[guide.mode] }, {
    signedIn: Boolean(me), isArtist: Boolean(me && world.artistById[myArtistId()]), page: guidePage(), renderRef: guideRef, inlineRef: guideInlineRef,
  });
  const newLog = $('.guide-log', panel);
  if (newLog && nearBottom) newLog.scrollTop = newLog.scrollHeight;
  if (hadFocus) { const i = $('#guide-input'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }
}

/** Updates only the reply being written (fast while it streams). */
function updateGuideStream() {
  const el = $('#guide .guide-msg.is-streaming .guide-text');
  const thread = guide.threads[guide.mode];
  if (!el) return renderGuide();
  el.innerHTML = replyHTML(thread.at(-1).content, { renderRef: guideRef, inlineRef: guideInlineRef });
  const log = $('#guide .guide-log');
  if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight;
}

/** A plain message for anything that went wrong, never code or provider details. */
function guideFailure(e) {
  if (e?.stale) return { message: 'Abremi was just updated. Refresh to use the Guide.', refresh: true };
  if (e instanceof TypeError && /fetch|load failed|network/i.test(e.message || '')) return { message: 'Couldn’t reach Abremi. Check your connection and try again.', retry: true };
  if (!(e instanceof Error) || e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError) {
    reportError(e?.message || String(e), 'guide');
    return { message: 'Something went wrong on this page. Refresh and try again.', refresh: true };
  }
  const msg = e.message || 'The Guide is unavailable right now.';
  return { message: msg, retry: !/sign in|today’s|for artists|switched on|Choose a mode|comes with/i.test(msg) };
}

function openGuide() {
  guide.open = true;
  guide.error = null;
  guideEvent('open', null);
  if (me && cloud?.guideUsage && !guide.loaded) {
    guide.loaded = true;
    Promise.all([cloud.guideUsage().catch(() => null), cloud.guidePrefs().catch(() => null)])
      .then(([usage, prefs]) => { Object.assign(guide, { usage, prefs }); if (guide.open && !guide.busy) renderGuide(); });
  }
  renderGuide();
  setTimeout(() => ($('#guide-input') || $('#guide [data-act=guide-close]'))?.focus(), 30);
}

function closeGuide() {
  guide.open = false;
  renderGuide();
  $('#guide-launcher')?.focus();
}

async function guideSend(text) {
  text = String(text || '').trim();
  if (!text || guide.busy) return;
  if (!me) return openSignIn();
  const thread = guide.threads[guide.mode];
  if (thread.at(-1)?.role === 'user') thread.pop(); // an unanswered question is replaced
  thread.push({ role: 'user', content: text });
  guide.input = '';
  const input = $('#guide-input');
  if (input) input.value = '';
  await guideAsk();
}

async function guideAsk() {
  const mode = guide.mode;
  const thread = guide.threads[mode];
  const messages = thread.filter((m) => m.content).slice(-12);
  const reply = { role: 'assistant', content: '' };
  thread.push(reply);
  Object.assign(guide, { busy: true, error: null });
  renderGuide();
  let failed = null;
  try {
    // A page that is half-updated (some files from the previous version) can lack the Guide's call.
    if (typeof cloud?.guide !== 'function') throw Object.assign(new Error('stale'), { stale: true });
    await cloud.guide({ mode, messages, page: guidePage() }, (ev) => {
      if (ev.type === 'text') { reply.content += ev.text; if (guide.open && guide.mode === mode) updateGuideStream(); }
      else if (ev.type === 'done') guide.usage = ev.usage || guide.usage;
      else if (ev.type === 'error') failed = { message: ev.error, retry: ev.retry !== false };
    });
  } catch (e) {
    failed = guideFailure(e);
  }
  if (failed) {
    thread.splice(thread.indexOf(reply), 1);
    guide.error = failed;
  }
  guide.busy = false;
  renderGuide();
}

// ——— Artist Studio analytics (#studio) ———
const studio = { days: 30, data: undefined, reports: null, at: 0, loading: false };
function renderStudio(root) {
  if (!COMMUNITY) { root.innerHTML = `<div class="shell">${EmptyState({ icon: 'grid', title: 'Studio analytics run with accounts', body: 'They count real views, visits, likes and follows from members, so they need the shared database.' })}</div>`; return; }
  if (!me) { root.innerHTML = `<div class="shell">${EmptyState({ icon: 'lock', title: 'Sign in to see your Studio', action: PremiumButton('Sign in', { act: 'sign-in' }) })}</div>`; return; }
  if (cloud && !studio.loading && (studio.data === undefined || Date.now() - studio.at > 60_000)) {
    studio.loading = true;
    Promise.all([cloud.studio(studio.days), cloud.weeklyReports().catch(() => []), cloud.collectorInterest ? cloud.collectorInterest().catch(() => []) : []])
      .then(([data, reports, interest]) => {
        if (data?.works) for (const w of data.works) Object.assign(w, interest.find((x) => x.artwork === w.id) || {});
        Object.assign(studio, { data, reports, at: Date.now() });
      })
      .catch(() => Object.assign(studio, { data: studio.data ?? null, at: Date.now() }))
      .finally(() => { studio.loading = false; if (currentView() === 'studio' && !sheetRenderer) renderView(); });
  }
  if (studio.data === undefined) { root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 6 })}</div>`; return; }
  if (idx.badge === undefined && cloud?.artistIndexBadge && myArtistId()) {
    idx.badge = null;
    cloud.artistIndexBadge(myArtistId()).then((b) => { idx.badge = b; if (currentView() === 'studio' && b) renderView(); }).catch(() => {});
  }
  const v = lazyPage(root, 'studio');
  const badgeView = idx.badge?.rank ? lazyView('index') : null;
  if (!v) return;
  root.innerHTML = v.studioPage(studio.data, studio.reports, { days: studio.days, maxDays: studio.data?.max_days || 90, thumb: (id) => (world.artworkById[id] ? `<span class="rank-thumb">${ArtImage(world.artworkById[id])}</span>` : '') });
  if (badgeView) root.querySelector('.shell')?.insertAdjacentHTML('beforeend', badgeView.badgeEmbedHTML(idx.badge, { artistId: myArtistId(), origin: location.origin }));
}

/** #competition/<id>: the brief, entries, voting or results, and the rules. */
function renderCompetition(root) {
  const id = route().param;
  if (!COMMUNITY) { root.innerHTML = `<div class="shell">${competitionsHTML([], { demo: true })}</div>`; return; }
  const entry = arena.details.get(id);
  if (!cloud || !entry || (!entry.loading && Date.now() - entry.at > 15_000)) {
    if (cloud) {
      arena.details.set(id, { loading: true, data: entry?.data });
      cloud.competition(id)
        .then((data) => arena.details.set(id, { data, at: Date.now() }))
        .catch(() => arena.details.set(id, { data: entry?.data || null, error: true, at: Date.now() }))
        .finally(() => { if (route().name === 'competition' && route().param === id && !sheetRenderer) renderView(); });
    }
    if (!entry?.data) { root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 4 })}</div>`; return; }
  }
  const d = (arena.details.get(id) || entry).data;
  if (!d) {
    root.innerHTML = `<div class="shell">${EmptyState({ icon: 'trophy', title: 'Competition not found', action: '<a class="btn btn-secondary" href="#battle"><span>Arena</span></a>' })}</div>`;
    return;
  }
  root.innerHTML = competitionPage(d, {
    card: (w) => card(w), artwork: (aid) => world.artworkById[aid], signedIn: Boolean(me),
    canEnter: eligibleWorks(d).length > 0, now: Date.now(),
  });
}
/** Your published works that fit a competition (the server checks again). */
function eligibleWorks(d) {
  const mine = (world.worksByArtist[myArtistId()] || []).filter((w) => w.member);
  return d.kind === 'category' ? mine.filter((w) => w.category === d.category) : mine;
}
async function refreshCompetition(id) {
  arena.details.delete(id);
  arena.at = 0;
  renderView();
}

function vote(i) {
  if (battleOutcome || !battlePair) return;
  const winner = battlePair[i], loser = battlePair[1 - i];
  if (COMMUNITY && me && isMine(winner)) return toast('You can’t vote for your own work. Pick the other one, or skip.', { force: true });
  const wr = world.eloOf(winner), lr = world.eloOf(loser);
  const res = battleResult(wr, lr, state.user.role);
  const crowd = Math.round(expectedScore(wr, lr) * 100);
  const ratings = !COMMUNITY ? state.elo : me ? state.community.elo : null; // guests' votes are not recorded
  if (ratings) {
    ratings[winner.id] = res.winner;
    ratings[loser.id] = res.loser;
  }
  state.battles.voted++;
  state.battles.streak = crowd >= 50 ? state.battles.streak + 1 : 0;
  state.battles.history = [{ w: winner.id, l: loser.id, gain: res.gain, loss: res.loss, t: Date.now() }, ...(state.battles.history || [])].slice(0, 30);
  commit();
  if (COMMUNITY && me) {
    // The server is the referee: it applies the same maths and returns the official ratings.
    pendingWrites++;
    cloud.vote(winner.id, loser.id)
      .then((r) => {
        state.community.elo[winner.id] = r.winner_rating;
        state.community.elo[loser.id] = r.loser_rating;
        commit();
        if (!myStreak?.today) loadStreak();
      })
      .catch((e) => {
        state.community.elo[winner.id] = wr;
        state.community.elo[loser.id] = lr;
        state.battles.voted--;
        state.battles.history = state.battles.history.filter((h) => !(h.w === winner.id && h.l === loser.id));
        commit();
        toast(e?.message || 'Your vote was not counted. Try again.');
      })
      .finally(() => { pendingWrites--; });
  } else if (COMMUNITY) nudgeSignIn('votes');
  battleOutcome = { winner: i, res, crowd };
  const arena = $('.arena');
  if (arena) arena.outerHTML = battleArenaHTML(arena.classList.contains('arena-compact'));
  if (res.upset) toast('An upset. The underdog won.');
  const pair = battlePair;
  setTimeout(() => {
    if (battlePair !== pair) return;
    newBattle();
    const a = $('.arena');
    if (a) {
      a.outerHTML = battleArenaHTML(a.classList.contains('arena-compact'));
      if (currentView() === 'battle') renderView();
    }
  }, 1500);
}

// ——— Rankings ———
// Community mode: everyone compares with the same server-kept hourly chart (chart_baseline()).
let chartBase = null; // { key: hour fetched for, at: when that chart was kept, community, ranks, from }
let live = false;     // true while the Realtime subscription is connected

async function loadChartBaseline() {
  if (!cloud?.chartBaseline) return;
  const key = hourKey();
  if (chartBase?.key === key) return;
  try {
    const b = await cloud.chartBaseline();
    chartBase = { key, at: b ? Date.parse(b.taken_at || b.hour) : null, community: b ? snapshotToCommunity(b.snapshot) : null, ranks: null, from: null };
    insightCache = null;
  } catch { /* keep the previous chart; try again on the next refresh */ }
}

/** Ranks in the earlier chart, scored exactly like the current one. null when there is no earlier chart. */
function baselineRanks() {
  if (!chartBase?.community || !state.community) return null;
  if (chartBase.ranks && chartBase.from === state.community) return chartBase.ranks;
  const c = state.community, b = chartBase.community;
  const works = (c.artworks || []).filter((w) => w.createdAt && w.createdAt <= chartBase.at);
  const artistIds = new Set(works.map((w) => w.artistId));
  const then = createWorld(seed, {
    ...viewState(), deltas: b.deltas, elo: b.elo, followerDeltas: b.followerDeltas, scores: b.scores || null,
    memberArtists: (c.artists || []).filter((a) => artistIds.has(a.id)), memberArtworks: works,
  });
  chartBase.ranks = { art: rankMap(then.topArtworks()), artist: rankMap(then.topArtists()) };
  chartBase.from = state.community;
  return chartBase.ranks;
}

/** Rank movement compares with the chart from the start of the previous hour. No previous chart, no movement. */
function chartSnapshot() {
  if (COMMUNITY) return baselineRanks();
  const current = { art: rankMap(world.topArtworks()), artist: rankMap(world.topArtists()) };
  const stored = state.snapshot || { hour: hourKey(), ranks: current, prev: null };
  const { snapshot, previous } = rollSnapshot(stored, current);
  if (snapshot !== state.snapshot) { state.snapshot = snapshot; insightCache = null; saveState(state); }
  return previous;
}

function rankRow(r, kind, previous, { elo = false } = {}) {
  const move = previous === undefined ? '' : Movement(previous ? movement(r.item.id, r.rank, previous[kind]) : null);
  const crown = r.rank === 1 ? `<span class="crown" aria-label="Number one">${Icon('crown', { size: 14 })}</span>` : '';
  if (kind === 'artist') {
    const a = r.item;
    return `<li class="${r.rank <= 3 ? 'is-podium' : ''}"><button class="rank-row" data-act="artist" data-id="${a.id}">
      <span class="rank-num">${crown}${r.rank}</span>${previous !== undefined ? move : ''}
      ${Avatar(a, 'md')}<span class="rank-text"><b>${esc(a.name)} <span class="flag">${flag(a.country)}</span>${a.isMe ? ' <em>you</em>' : ''}</b><small>${esc(categoryById[a.category]?.label || '')} ${signalChips(a.id, { compact: true })}</small></span>
      <span class="rank-score">${fmt(r.score)}</span></button></li>`;
  }
  const w = r.item, a = artistOf(w);
  const cred = elo ? '' : `<small>${Math.round(credOf(w) * 100)}% credible</small>`;
  return `<li class="${r.rank <= 3 ? 'is-podium' : ''}"><button class="rank-row" data-act="artwork" data-id="${w.id}">
    <span class="rank-num">${crown}${r.rank}</span>${previous !== undefined ? move : ''}
    <span class="rank-thumb">${ArtImage(w)}</span><span class="rank-text"><b class="serif-title">${esc(w.title)}</b><small>${esc(a.name)} · ${esc(categoryById[w.category].label)}</small></span>
    <span class="rank-score">${elo ? Math.round(r.score) : fmt(r.score)}${cred}</span></button></li>`;
}

// ——— Member leaderboards (computed by the server; display names and scores only) ———
const memberCache = new Map(); // "country|season|medium" → { at, data, loading, error }
const monthStart = (offset = 0) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 10); };
const memberKey = () => `${charts.memberCountry || 'world'}|${charts.memberSeason || ''}|${charts.memberMedium || ''}`;

async function loadMembers(key) {
  const prev = memberCache.get(key);
  if (prev?.loading || !cloud) return;
  memberCache.set(key, { ...prev, loading: true });
  const [scope, season, medium] = key.split('|');
  try {
    const data = await cloud.leaderboards(scope === 'world' ? null : scope, { season: season || null, medium: medium || null });
    memberCache.set(key, { at: Date.now(), data, loading: false });
  } catch (e) {
    memberCache.set(key, { ...prev, at: Date.now(), loading: false, error: e?.message || 'Leaderboards are unavailable right now.' });
  }
  if (currentView() === 'charts' && charts.tab === 'members' && !sheetRenderer) renderView();
}

const MEMBER_BOARDS = {
  collectors: { title: 'Top Collectors', detail: (n) => `${fmt(n)} influence added as a collector`, qualify: 'Collector status is granted after verification.' },
  critics: { title: 'Top Critics', detail: (n) => `${n} review${n === 1 ? '' : 's'}`, qualify: 'Critic status is granted after verification.' },
  discoverers: { title: 'Top Discoverers', detail: (n) => `${n} discoveries`, qualify: 'Like works before others do: three discoveries put you on the board.' },
};

function memberRow(row) {
  const crown = row.rank === 1 ? `<span class="crown">${Icon('crown', { size: 14 })}</span>` : '';
  const person = { name: row.name, palette: hashString(row.name) % PALETTES.length };
  return `<li class="${row.rank <= 3 ? 'is-podium' : ''}${row.me ? ' is-me' : ''}"><div class="rank-row">
    <span class="rank-num">${crown}${row.rank}</span>${Avatar(person, 'md')}
    <span class="rank-text"><b>${esc(row.name)} <span class="flag">${flag(row.country)}</span>${row.me ? ' <em>you</em>' : ''}</b><small>${esc(MEMBER_BOARDS[row.board].detail(row.detail))}</small></span>
    <span class="rank-score">${row.board === 'discoverers' ? `${row.score}<small>/ 100</small>` : fmt(row.score)}</span></div></li>`;
}

function membersBoardsHTML() {
  if (!COMMUNITY) {
    return `<section class="board">${EmptyState({ icon: 'user', title: 'Member leaderboards go live with accounts',
      body: 'Top Collectors, Top Critics and Top Discoverers rank real members. This site is in demo mode, so there is nobody to rank yet. Your own Taste Score is on your profile.',
      action: '<a class="btn btn-secondary" href="#profile"><span>See your Taste Score</span></a>' })}</section>`;
  }
  const scope = charts.memberCountry || 'world';
  const season = charts.memberSeason || '';
  const medium = charts.memberMedium || '';
  const key = memberKey();
  const entry = memberCache.get(key);
  if (!entry || (!entry.loading && Date.now() - entry.at > 60_000)) setTimeout(() => loadMembers(key), 0);
  const country = state.user.country;
  const seasons = [['', 'All time'], [monthStart(0), seasonName(monthStart(0)).split(' ')[0]], [monthStart(-1), seasonName(monthStart(-1)).split(' ')[0]]];
  const pills = `<div class="chip-row pill-row" role="tablist" aria-label="Region">
    <button class="chip${scope === 'world' ? ' is-on' : ''}" role="tab" aria-selected="${scope === 'world'}" data-act="members-scope" data-v="">Worldwide</button>
    <button class="chip${scope === country ? ' is-on' : ''}" role="tab" aria-selected="${scope === country}" data-act="members-scope" data-v="${country}">${flag(country)} ${esc(countryName(country))}</button></div>
    <div class="league-row">
      <div class="chip-row pill-row" role="tablist" aria-label="Season">${seasons.map(([v, label]) => `<button class="chip${season === v ? ' is-on' : ''}" role="tab" aria-selected="${season === v}" data-act="members-season" data-v="${v}">${esc(label)}</button>`).join('')}</div>
      <label class="league-medium"><span class="sr-only">Medium</span><select id="members-medium" aria-label="Medium league">
        <option value="">All media</option>${CATEGORIES.map((c) => `<option value="${c.id}"${medium === c.id ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
    </div>`;
  if (!entry?.data) {
    return `${pills}${entry?.error ? EmptyState({ title: 'Leaderboards are unavailable', body: entry.error, action: PremiumButton('Try again', { act: 'members-retry', variant: 'secondary' }) }) : LoadingSkeleton({ cards: 5, variant: 'list' })}`;
  }
  const d = entry.data;
  const standing = me ? `<section class="standing">
      <p class="eyebrow">Your standing${scope === 'world' ? ' worldwide' : ` in ${esc(countryName(scope))}`}${medium ? ` · ${esc(categoryById[medium]?.label || medium)}` : ''}${season ? ` · ${esc(seasonName(season))}` : ''}</p>
      <div class="standing-grid">${['discoverers', 'collectors', 'critics'].map((k) => [k, MEMBER_BOARDS[k]]).map(([k, b]) => {
        const s = d.me?.[k];
        return `<div class="standing-item${s ? ' is-ranked' : ''}"><small>${b.title.replace('Top ', '')}</small>
          ${s ? `<b>No. ${s.rank}</b><span>${k === 'discoverers' ? `${s.score} / 100` : fmt(s.score)}</span>` : `<span class="muted">${esc(b.qualify)}</span>`}</div>`;
      }).join('')}</div>
      ${state.user.publicLeaderboards === false ? '<p class="fine">You have chosen not to appear publicly; only you can see your position.</p>' : ''}
    </section>` : `<p class="board-note"><button class="link" data-act="sign-in">Sign in</button> to see where you stand.</p>`;
  const board = (k) => {
    const rows = (d[k] || []).map((r) => ({ ...r, board: k }));
    return `<section class="board"><header class="board-head"><h2>${MEMBER_BOARDS[k].title}</h2></header>
      ${rows.length ? `<ol class="rank-list">${rows.map(memberRow).join('')}</ol>` : `<p class="board-note">Nobody here yet. ${esc(MEMBER_BOARDS[k].qualify)}</p>`}</section>`;
  };
  return `${pills}${standing}${board('discoverers')}${board('collectors')}${board('critics')}
    <p class="fine explainer"><b>Seasons</b> run for a calendar month (UTC) and count only what members did that month; on the 1st, each board’s top 10 is frozen and becomes a permanent achievement. <b>Leagues</b> narrow the boards to a country or a medium. <b>Discovery Score</b> rewards liking work before others do: the more weight (Fan 1 … Collector 9) that arrives after you, and the earlier you were, the higher it climbs. <b>Collectors</b> and <b>critics</b> are ranked by the influence they have added in that role; critics’ reviews count too. Members appear by display name only and can opt out in their profile. ${fmt(d.members || 0)} member${d.members === 1 ? '' : 's'} on the boards.</p>`;
}

/** Cultural Influence by Country. Community mode lists only countries with real activity. */
function countryBoard() {
  const rows = countryStandings(world.artists, (a) => world.artistScores[a.id], world.artworks, (w) => world.influence[w.id]);
  return COMMUNITY ? rows.filter((r) => r.score > 0) : rows;
}

function countryRow(row) {
  const c = countryByCode[row.country];
  const crown = row.rank === 1 ? `<span class="crown">${Icon('crown', { size: 14 })}</span>` : '';
  return `<li class="${row.rank <= 3 ? 'is-podium' : ''}"><button class="rank-row" data-act="chart-country" data-v="${row.country}">
    <span class="rank-num">${crown}${row.rank}</span><span class="country-flag">${c?.flag || ''}</span>
    <span class="rank-text"><b>${esc(c?.name || row.country)}</b><small>${row.artists} artists · led by ${esc(row.topArtist?.name || '—')}</small></span>
    <span class="rank-score">${fmt(row.score)}</span></button></li>`;
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function chartStatusHTML(hour) {
  if (!COMMUNITY) return `<p class="muted">Updated hourly · ${hour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>`;
  const since = chartBase?.at ? ` · <span class="chart-since">Movement since ${clock(chartBase.at)}</span>` : '';
  const status = live
    ? '<span class="live-badge is-live"><span class="live-dot" aria-hidden="true"></span>Live</span>'
    : `<span class="live-badge">Updated ${clock(state.community?.fetchedAt || Date.now())}</span>`;
  return `<p class="muted chart-status" id="chart-status">${status}${since}</p>`;
}

function renderCharts(root) {
  const previous = chartSnapshot();
  const hour = new Date();
  hour.setMinutes(0, 0, 0);
  const section = (key, title, list, kind, opts = {}) => {
    const open = charts.expanded === key;
    list = list.filter((r) => r.rank != null);
    const rows = list.slice(0, open ? 100 : 5);
    return `<section class="board" data-board="${key}">
      <header class="board-head"><h2>${title}</h2>${list.length > 5 ? `<button class="link-arrow" data-act="chart-expand" data-v="${key}">${open ? 'Show top 5' : 'See all'} ${Icon('arrow', { size: 14 })}</button>` : ''}</header>
      ${rows.length ? `<ol class="rank-list">${rows.map((r) => rankRow(r, kind, opts.previous || undefined, opts)).join('')}</ol>` : EmptyState({ title: 'Nothing ranked here yet', body: COMMUNITY ? 'Rankings come only from real members’ likes, saves, follows and battle votes.' : '' })}
    </section>`;
  };
  const tabs = Object.entries({ global: 'Global', countries: 'Countries', categories: 'Categories', members: 'Members' })
    .map(([k, v]) => `<button role="tab" aria-selected="${charts.tab === k}" class="${charts.tab === k ? 'is-on' : ''}" data-act="chart-tab" data-v="${k}">${v}</button>`).join('');
  let body;
  if (charts.tab === 'global') {
    const standings = countryBoard();
    body = `${COMMUNITY && state.community?.scores ? section('trending', 'Trending This Week', world.topTrending(), 'art', { trending: true }) : ''}
      ${section('artworks', COMMUNITY ? 'Top Artworks · All Time' : 'Top Artworks Worldwide', world.topArtworks(), 'art', { previous })}
      ${section('artists', 'Top Artists Worldwide', world.topArtists(), 'artist', { previous })}
      ${COMMUNITY && state.community?.scores ? section('collected', 'Collectors’ Picks', world.topCollected(), 'art', { collector: true }) : ''}
      ${section('battles', 'Art Battle Champions', world.topElo(), 'art', { elo: true })}
      <section class="board">
        <header class="board-head"><h2>Cultural Influence by Country</h2><button class="link-arrow" data-act="chart-tab" data-v="countries">All countries ${Icon('arrow', { size: 14 })}</button></header>
        <ol class="rank-list">${standings.slice(0, 5).map(countryRow).join('')}</ol>
      </section>`;
  } else if (charts.tab === 'countries') {
    if (charts.country) {
      const c = countryByCode[charts.country];
      body = `<button class="link-arrow back-link" data-act="chart-country" data-v="">${Icon('back', { size: 14 })} All countries</button>
        <h2 class="display-sm board-title">${c.flag} ${esc(c.name)}</h2>
        ${section('c-artworks', `Top Artworks · ${esc(c.name)}`, world.topArtworks({ country: c.code }), 'art')}
        ${section('c-artists', `Top Artists · ${esc(c.name)}`, world.topArtists({ country: c.code }), 'artist')}`;
    } else {
      const standings = countryBoard();
      const mine = standings.find((r) => r.country === state.user.country);
      body = `<section class="board">
        <header class="board-head"><h2>Cultural Influence by Country</h2></header>
        ${mine ? `<p class="board-note">${flag(mine.country)} ${esc(countryName(mine.country))}, your country, is <b>No. ${mine.rank}</b>. Every like you give its artists counts.</p>` : ''}
        <ol class="rank-list">${standings.map(countryRow).join('')}</ol>
      </section>`;
    }
  } else if (charts.tab === 'members') {
    body = membersBoardsHTML();
  } else {
    const cat = charts.category || 'oil';
    body = `${CategoryFilter(CATEGORIES, cat, { act: 'chart-cat', pills: true, noAll: true })}
      ${section('k-artworks', `Top ${esc(categoryById[cat].label)}`, world.topArtworks({ category: cat }), 'art')}
      ${section('k-artists', `Top ${esc(categoryById[cat].label)} Artists`, world.topArtists({ category: cat }), 'artist')}`;
  }
  root.innerHTML = `<div class="shell charts">
    <header class="rank-head">
      <div><h1 class="display-lg">Rankings</h1>${chartStatusHTML(hour)}</div>
      ${Icon('globe', { size: 26, label: 'Worldwide' })}
    </header>
    <div class="seg seg-gold" role="tablist">${tabs}</div>
    ${body}
    ${COMMUNITY ? `<button class="link-arrow how-ranked" data-act="how-ranked">${Icon('info', { size: 14 })} How rankings work</button>` : ''}
    <p class="fine explainer"><b>Score</b> is popularity: every like weighted by who gave it (Fan 1, Artist 3, Critic 5, Collector 9; Treasures count ×${SAVE_MULTIPLIER}). <b>Credible</b> is the share of that score from critics and collectors. Rankings are organic: nobody can pay to move them.</p>
  </div>`;
  $('#members-medium', root)?.addEventListener('change', (e) => { charts.memberMedium = e.target.value; renderView(); });
}

// ——— Explore ———
const SORTS = {
  trending: { label: 'Trending', fn: (a, b) => world.influence[b.id] - world.influence[a.id] },
  new: { label: 'Newest', fn: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.year - a.year || world.influence[b.id] - world.influence[a.id] },
  battle: { label: 'Battle rating', fn: (a, b) => world.eloOf(b) - world.eloOf(a) },
  priceHigh: { label: 'Price: high to low', fn: (a, b) => (listedPrice(b) ?? -1) - (listedPrice(a) ?? -1) },
  priceLow: { label: 'Price: low to high', fn: (a, b) => (listedPrice(a) ?? Infinity) - (listedPrice(b) ?? Infinity) },
};

function renderExplore(root) {
  const all = world.artworks.filter((w) =>
    (!explore.category || w.category === explore.category) &&
    (!explore.style || w.style === explore.style) &&
    (!explore.country || artistOf(w)?.country === explore.country)).sort(SORTS[explore.sort].fn);
  const shown = all.slice(0, explore.limit);
  const activeFilters = [
    explore.style && { k: 'style', label: explore.style },
    explore.country && { k: 'country', label: countryName(explore.country) },
  ].filter(Boolean);
  root.innerHTML = `<div class="shell explore">
    <header class="page-head page-head-row">
      <div><p class="eyebrow">Explore</p><h1 class="display-lg">The full collection</h1><p class="muted">${all.length} works</p></div>
      <div class="toolbar-inline">
        ${Select('explore-style', [{ value: '', label: 'All movements' }, ...STYLES.map((s) => ({ value: s, label: s }))], explore.style, 'Movement')}
        ${Select('explore-sort', Object.entries(SORTS).map(([k, v]) => ({ value: k, label: v.label })), explore.sort, 'Sort')}
      </div>
    </header>
    ${CategoryFilter(CATEGORIES, explore.category, { act: 'explore-cat', allLabel: 'All mediums' })}
    ${activeFilters.length ? `<div class="active-filters">${activeFilters.map((f) => `<button class="tag" data-act="explore-clear" data-v="${f.k}">${esc(f.label)} ${Icon('x', { size: 14 })}</button>`).join('')}</div>` : ''}
    ${shown.length ? ArtworkGrid(shown.map((w) => card(w))) : EmptyState({ title: 'No works match', body: 'Loosen a filter to see more.' })}
    ${all.length > shown.length ? `<div class="section-foot center">${PremiumButton(`Show more · ${all.length - shown.length} remaining`, { act: 'explore-more', variant: 'secondary' })}</div>` : ''}
  </div>`;
  $('#explore-sort', root).addEventListener('change', (e) => { explore.sort = e.target.value; explore.limit = 24; renderView(); });
  $('#explore-style', root).addEventListener('change', (e) => { explore.style = e.target.value; explore.limit = 24; renderView(); });
}

// ——— Artists ———
// ——— Artist page ———
let artistTab = 'artwork';
function renderArtistPage(root) {
  const id = route().param;
  const a = world.artistById[id];
  if (!a) {
    root.innerHTML = `<div class="shell">${EmptyState({ title: 'Artist not found', body: 'They may have left Abremi.', action: '<a class="btn btn-secondary" href="#artists"><span>All artists</span></a>' })}</div>`;
    return;
  }
  if (a.member && !a.isMe) track('profile_visit', id);
  const works = world.topArtworks().filter((r) => r.item.artistId === id).map((r) => (r.rank == null ? { ...r, rank: undefined } : r));
  const cover = works[0]?.item;
  const followers = world.followersOf(a);
  const followerTotal = Object.values(followers).reduce((x, y) => x + y, 0);
  const following = !!state.follows[id];
  const ins = artistInsights();
  const badges = world.badgesOf(a);
  const cred = ins.cred[id];
  root.innerHTML = `<div class="artist-page">
    <div class="artist-banner">${cover ? ArtImage(cover, { full: true }) : ''}
      <div class="artist-banner-bar shell"><button class="icon-btn glass" data-act="back" aria-label="Back">${Icon('back')}</button>
        <button class="icon-btn glass" data-act="share-artist" data-id="${id}" aria-label="Share">${Icon('share')}</button></div>
    </div>
    <div class="shell">
      <header class="artist-header">
        <span class="artist-portrait">${Avatar(a, 'xl')}</span>
        <div class="artist-header-actions">
          ${a.isMe ? '<span class="tag tag-gold">This is you</span>' : `<button class="btn ${following ? 'btn-secondary' : 'btn-primary'}" data-act="follow" data-id="${id}" aria-pressed="${following}"><span>${following ? 'Following' : 'Follow'}</span></button>
            ${a.sample ? '' : `${state.user.role === 'collector' ? PremiumButton('Sponsor', { act: 'sponsor', variant: 'secondary', attrs: `data-id="${id}"` }) : ''}
            ${IconButton('mail', `Contact ${a.name}`, { act: 'contact', attrs: `data-id="${id}"` })}`}`}
        </div>
        <h1 class="display-md">${esc(a.name)}${member.badges[id] ? ` <span class="plan-badge" title="Artist ${esc(member.badges[id])} member (a plan; it doesn’t affect rankings)">${esc(member.badges[id])}</span>` : ''}</h1>
        ${COMMUNITY && (loadFounding(), isFounding(id)) ? '<p class="founding-badge"><span class="tag tag-gold" title="Chosen by Abremi to open the platform. It doesn’t affect rankings.">Founding artist</span></p>' : ''}
        ${a.sample ? SampleNote('artist') : ''}
        ${isAdmin && a.member ? `<button class="link-arrow founding-toggle" data-act="toggle-founding" data-id="${id}" data-v="${isFounding(id) ? '' : '1'}">${Icon('spark', { size: 14 })} ${isFounding(id) ? 'Remove from Founding artists' : 'Make a Founding artist'}</button>` : ''}
        <p class="muted">${esc(categoryById[a.category]?.label || 'Contemporary')} artist • ${a.city ? `${esc(a.city)}, ` : ''}${esc(countryName(a.country))}${a.debutYear ? ` • since ${a.debutYear}` : ''}</p>
        ${a.bio ? `<p class="artist-bio">${esc(a.bio)}</p>` : ''}
        ${a.isMe && a.member ? `<button class="link-arrow" data-act="edit-artist-profile">${Icon('pen', { size: 14 })} Edit your artist profile</button>` : ''}
        <div class="signal-row">${signalChips(id)}${COMMUNITY ? artistAchievementsHTML(id) : badges.map((b) => `<span class="badge" title="${esc(BADGES[b].desc)}">${BADGES[b].emoji} ${BADGES[b].label}</span>`).join('')}</div>
        <dl class="stat-row artist-stats">
          <div><dt>Followers</dt><dd>${fmt(followerTotal)}</dd></div>
          <div><dt>Works</dt><dd>${works.length}</dd></div>
          <div><dt>Influence</dt><dd>${fmt(world.artistScores[id])}</dd></div>
          <div><dt>Worldwide</dt><dd>${world.globalArtistRanks[id] ? `No. ${world.globalArtistRanks[id]}` : 'Not ranked'}</dd></div>
        </dl>
      </header>
      <div class="tabs" role="tablist">
        ${[['artwork', 'Artwork'], ['about', 'About'], ...(COMMUNITY && a.member ? [['passport', 'Passport']] : [])].map(([k, v]) => `<button role="tab" class="${artistTab === k ? 'is-on' : ''}" aria-selected="${artistTab === k}" data-act="artist-tab" data-v="${k}">${v}</button>`).join('')}
      </div>
      ${artistTab === 'passport' && COMMUNITY && a.member ? passportTabHTML(id) : artistTab === 'artwork'
        ? (works.length ? ArtworkGrid(works.map((r) => card(r.item, { rank: r.rank, details: true }))) : EmptyState({ title: 'No works yet' }))
        : `${a.statement ? `<section class="artist-statement"><h2 class="eyebrow">Artist statement</h2><p>${esc(a.statement)}</p></section>` : ''}
          ${a.website || a.instagram ? `<p class="artist-links">${a.website ? `<a href="${esc(a.website)}" target="_blank" rel="noopener noreferrer nofollow">${Icon('globe', { size: 14 })} ${esc(a.website.replace(/^https:\/\//, '').replace(/\/$/, ''))}</a>` : ''}
            ${a.instagram ? `<a href="https://instagram.com/${encodeURIComponent(a.instagram)}" target="_blank" rel="noopener noreferrer nofollow">@${esc(a.instagram)}</a>` : ''}</p>` : ''}
          <dl class="spec about-spec">
            <div><dt>Movements</dt><dd>${a.styles.length ? a.styles.map(esc).join(', ') : '—'}</dd></div>
            <div><dt>Medium</dt><dd>${esc(categoryById[a.category]?.label || '—')}</dd></div>
            <div><dt>Country</dt><dd>${flag(a.country)} ${esc(countryName(a.country))}${world.countryArtistRanks[id] ? ` · No. ${world.countryArtistRanks[id]}` : ''}</dd></div>
            <div><dt>Credibility</dt><dd>${Math.round((cred?.share || 0) * 100)}% of influence from critics &amp; collectors</dd></div>
            <div><dt>Followers by role</dt><dd>${ROLES.map((r) => `${r.label} ${fmt(followers[r.id])}`).join(' · ')}</dd></div>
            ${a.member ? '<div><dt>Profile</dt><dd>Member artist on Abremi</dd></div>' : ''}
          </dl>`}
    </div>
  </div>`;
}

// An artist's achievements, earned on the server (community mode), fetched when their page opens.
const artistAchievementCache = new Map();
function artistAchievementsHTML(id) {
  if (!cloud?.artistAchievements || world.artistById[id]?.sample) return '';
  const entry = artistAchievementCache.get(id);
  if (!entry || (!entry.loading && Date.now() - entry.at > 60_000)) {
    artistAchievementCache.set(id, { loading: true, list: entry?.list || [] });
    cloud.artistAchievements(id)
      .then((list) => artistAchievementCache.set(id, { list: list || [], at: Date.now() }))
      .catch(() => artistAchievementCache.set(id, { list: [], at: Date.now() }))
      .finally(() => { if (route().name === 'artist' && route().param === id && !sheetRenderer) renderView(); });
  }
  return (artistAchievementCache.get(id).list || [])
    .map((a) => `<span class="badge" title="${esc(a.criteria)}">${AbremiSymbol(12)} ${esc(a.label)}</span>`).join('');
}

function renderArtists(root) {
  const list = world.topArtists({ country: artistsView.country || null, category: artistsView.category || null });
  const shown = list.slice(0, artistsView.limit);
  root.innerHTML = `<div class="shell artists">
    <header class="page-head page-head-row">
      <div><p class="eyebrow">Artists</p><h1 class="display-lg">The people behind the work</h1><p class="muted">${list.length} artists${artistsView.country ? ` in ${esc(countryName(artistsView.country))}` : ' worldwide'}</p></div>
      ${Select('artists-country', [{ value: '', label: 'All countries' }, ...COUNTRIES.map((c) => ({ value: c.code, label: c.name }))], artistsView.country, 'Country')}
    </header>
    ${CategoryFilter(CATEGORIES, artistsView.category, { act: 'artists-cat', allLabel: 'All disciplines' })}
    <div class="artist-grid">${shown.map((r) => ArtistCard(r.item, { cover: coverOf(r.item.id), following: !!state.follows[r.item.id], score: r.score, rank: r.rank })).join('')}</div>
    ${list.length > shown.length ? `<div class="section-foot center">${PremiumButton('Show more artists', { act: 'artists-more', variant: 'secondary' })}</div>` : ''}
  </div>`;
  $('#artists-country', root).addEventListener('change', (e) => { artistsView.country = e.target.value; artistsView.limit = 24; renderView(); });
}

// ——— Collections ———
function renderCollections(root) {
  const saved = collectionIds('saved'), liked = collectionIds('liked'), purchased = collectionIds('purchased');
  const taste = myTaste();
  const earned = myAchievements(taste);
  const total = personalInfluence(state.interactions, state.interactionRoles, state.reviews);
  const series = dailyActivity(state.activity, 14);
  const thisWeek = series.slice(7).reduce((a, b) => a + b, 0), lastWeek = series.slice(0, 7).reduce((a, b) => a + b, 0);
  const trend = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const collectorElite = userBadges({ role: state.user.role, collectedCount: saved.length + state.purchases.length, reviewCount: state.reviews.length }).includes('collectorElite');
  const followed = Object.keys(state.follows).map((id) => world.artistById[id]).filter(Boolean);
  const mineCards = [
    { k: 'saved', title: 'Treasures', ids: saved, icon: 'treasure', empty: 'The works you treasure' },
    { k: 'liked', title: 'Admired', ids: liked, icon: 'admire', empty: 'Start from Discover' },
    { k: 'purchased', title: 'Acquired', ids: purchased, icon: 'collection', empty: 'Works you acquire appear here' },
  ];
  const top = world.topArtworks().map((r) => r.item).filter((w) => !isMine(w));
  const editions = STYLES.map((s) => ({ s, works: top.filter((w) => w.style === s) })).filter((x) => x.works.length >= 4);

  root.innerHTML = `<div class="shell collections">
    <header class="collector-head">
      <span class="avatar avatar-lg avatar-me">${esc(initials(state.user.name))}</span>
      <div><p class="muted">${greeting},</p><h1 class="display-sm">${esc(state.user.name)}</h1>
        <p class="collector-tags"><span class="tag">${role().label} ×${role().weight}</span>${collectorElite ? `<span class="tag tag-gold">${Icon('crown', { size: 14 })} Collector Elite</span>` : ''}${taste.score != null ? `<span class="tag tag-gold">${esc(taste.tier)}</span>` : ''}</p></div>
    </header>

    <div class="dash-grid">
      <section class="influence-card">
        <div><p class="eyebrow">Cultural Influence</p><p class="influence-total">${fmt(total)}</p><p class="muted">Weight you have added to the rankings</p></div>
        <div class="influence-trend">
          ${trend !== null ? `<span class="move ${trend >= 0 ? 'move-up' : 'move-down'}">${trend >= 0 ? '↑' : '↓'} ${Math.abs(trend)}%</span>` : thisWeek ? `<span class="move move-up">+${fmt(thisWeek)} this week</span>` : ''}
          ${sparkline(series.slice(7))}
        </div>
      </section>
      ${tasteCardHTML(taste, { compact: true })}
    </div>

    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Private · on this device', title: 'My Collections', action: PremiumButton('New collection', { act: 'new-collection', variant: 'secondary', icon: 'plus' }) })}
      <div class="collection-grid">
        ${mineCards.map(({ k, title, ids, icon, empty }) => ids.length
          ? CollectionCard({ title, subtitle: `${ids.length} work${ids.length === 1 ? '' : 's'}`, works: ids.map((id) => world.artworkById[id]), act: 'open-collection', attrs: `data-v="${k}"` })
          : `<div class="collection-card is-empty"><div class="mosaic mosaic-empty">${Icon(icon, { size: 26 })}</div><span class="collection-text"><b>${title}</b><small>${empty}</small></span></div>`).join('')}
        ${state.collections.map((c) => {
          const works = c.ids.map((id) => world.artworkById[id]).filter(Boolean);
          return works.length
            ? CollectionCard({ title: c.name, subtitle: `${works.length} work${works.length === 1 ? '' : 's'}${c.private ? ' · private' : ''}`, works, act: 'open-user-collection', attrs: `data-v="${c.id}"` })
            : `<button class="collection-card is-empty" data-act="open-user-collection" data-v="${c.id}"><div class="mosaic mosaic-empty">${Icon('folderPlus', { size: 26 })}</div><span class="collection-text"><b>${esc(c.name)}</b><small>Add works from any artwork’s details</small></span></button>`;
        }).join('')}
      </div>
    </section>

    ${earned.length ? `<section class="section section-tight">${SectionHeader({ eyebrow: 'Recognition', title: 'Achievements', action: `<a class="link-arrow" href="#profile">All achievements ${Icon('arrow', { size: 16 })}</a>` })}
      <div class="achievement-row">${earned.map((id) => `<span class="achievement is-earned" title="${esc(achievementCatalog()[id]?.desc || '')}">${AbremiSymbol(16)} ${esc(achievementCatalog()[id]?.label || id)}</span>`).join('')}</div></section>` : ''}

    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Following', title: 'Artists you follow' })}
      ${followed.length ? `<div class="artist-grid">${followed.map((a) => ArtistCard(a, { cover: coverOf(a.id), following: true, rank: world.globalArtistRanks[a.id], signals: signalChips(a.id) })).join('')}</div>` : EmptyState({ icon: 'user', title: 'Not following anyone yet', body: 'Follow artists to subscribe to their journey.' })}
    </section>

    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Curated', title: 'Movements' })}
      <div class="collection-grid">${editions.map(({ s, works }) => CollectionCard({ title: `The ${s} edit`, subtitle: `${works.length} works`, works, act: 'open-style', attrs: `data-v="${esc(s)}"` })).join('')}</div>
    </section>
  </div>`;
}

function sparkline(values) {
  const w = 120, h = 36, max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 3 - (v / max) * (h - 6)}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="Influence added each day this week"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function tasteCardHTML(taste, { compact = false } = {}) {
  if (taste.score == null) {
    const have = MIN_DISCOVERIES - taste.needed;
    return `<section class="taste-card is-locked${compact ? ' is-compact' : ''}">
      <div class="taste-ring" style="--p:${(have / MIN_DISCOVERIES) * 100}%"><b>${have}/${MIN_DISCOVERIES}</b></div>
      <div><p class="eyebrow">Taste Score</p><h3 class="display-sm">Discover ${taste.needed} more</h3>
      <p class="muted">Admire or treasure ${taste.needed} more work${taste.needed === 1 ? '' : 's'} to reveal how early your eye is.</p></div>
    </section>`;
  }
  const p = taste.parts;
  return `<section class="taste-card spotlight${compact ? ' is-compact' : ''}">
    <div class="taste-ring" style="--p:${taste.score}%"><b>${taste.score}</b></div>
    <div><p class="eyebrow">Taste Score</p><h3 class="display-sm">${esc(taste.tier)}</h3>
      ${compact ? `<p class="muted">From ${taste.count} discoveries</p>` : `<ul class="taste-parts">
        <li><span>Hidden gems</span><b>${Math.round(p.gems * 100)}%</b><small>of your finds were outside the top quarter when you found them</small></li>
        <li><span>Foresight</span><b>${Math.round(p.foresight * 100)}%</b><small>average climb of the works you found, since you found them</small></li>
        <li><span>Range</span><b>${Math.round(p.range * 100)}%</b><small>movements explored (six or more is full range)</small></li>
      </ul>`}
    </div>
  </section>`;
}

// ——— Scan ———
function renderScan(root) {
  root.innerHTML = `<div class="shell scan">
    <header class="page-head page-head-center"><p class="eyebrow">Artwork recognition</p><h1 class="display-lg">Point. Identify. Discover.</h1>
      <p class="lede">Photograph any artwork, in a gallery, on a wall or on a screen. Abremi reads its style and medium, then finds artists working in the same vein.</p></header>
    <div class="scan-actions">
      <label class="dropzone"><input type="file" id="scan-file" accept="image/*" capture="environment">${Icon('scan', { size: 28 })}<b>Take or upload a photo</b><small>JPG, PNG or HEIC</small></label>
      ${PremiumButton('Try it on a random artwork', { act: 'scan-sample', variant: 'secondary', icon: 'spark' })}
    </div>
    <div id="scan-result">${scanning ? LoadingSkeleton({ cards: 3, variant: 'list' }) : lastScan ? scanResultHTML(lastScan) : ''}</div>
  </div>`;
  $('#scan-file', root).addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    await runScan(url, file.name);
    URL.revokeObjectURL(url);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function runScan(src, label) {
  scanning = true;
  if (currentView() === 'scan') $('#scan-result').innerHTML = LoadingSkeleton({ cards: 3, variant: 'list' });
  try {
    const img = await loadImage(src);
    const w = 160, h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * 160)) || 200;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const features = extractFeatures(ctx.getImageData(0, 0, w, h).data, w, h);
    const styles = classifyStyle(features);
    const medium = guessMedium(features);
    const artists = similarArtists(world.artists.filter((a) => !a.isMe), styles, medium, (a) => world.artistScores[a.id]);
    const works = world.topArtworks().map((r) => r.item).filter((x) => x.style === styles[0].name).slice(0, 4);
    lastScan = { preview: canvas.toDataURL('image/jpeg', 0.8), label, features, styles, medium, artists, works };
  } catch {
    toast('Could not read that image.');
  }
  scanning = false;
  if (currentView() === 'scan') $('#scan-result').innerHTML = lastScan ? scanResultHTML(lastScan) : '';
}

function scanResultHTML(s) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  return `<section class="scan-result">
    <div class="scan-summary">
      <img src="${s.preview}" alt="Scanned image" class="scan-preview">
      <div><p class="eyebrow">Identified</p><h2 class="display-md">${esc(s.styles[0].name)}</h2><p class="muted">${esc(s.medium.label)}${s.label ? ` · ${esc(s.label)}` : ''}</p>
        <div class="meters">${s.styles.slice(0, 4).map((x) => `<div class="meter-row"><span>${esc(x.name)}</span><div class="meter"><i style="width:${pct(x.confidence)}"></i></div><span class="num">${pct(x.confidence)}</span></div>`).join('')}</div>
        <p class="fine">Brightness ${pct(s.features.brightness)} · saturation ${pct(s.features.saturation)} · texture ${pct(s.features.edgeDensity)} · hue variety ${pct(s.features.hueVariety)}</p>
      </div>
    </div>
    <div class="scan-columns">
      <div><h3 class="sub-head">Similar artists</h3><ol class="rank-list">${s.artists.map(({ artist: a }) => `<li><button class="rank-row" data-act="artist" data-id="${a.id}">${Avatar(a, 'md')}<span class="rank-text"><b>${esc(a.name)}</b><small>${esc(countryName(a.country))} · ${a.styles.map(esc).join(', ')}</small></span><span class="rank-score">${fmt(world.artistScores[a.id])}</span></button></li>`).join('')}</ol></div>
      <div><h3 class="sub-head">More ${esc(s.styles[0].name)}</h3>${ArtworkGrid(s.works.map((w) => card(w)), { className: 'art-grid-tight' })}</div>
    </div>
    <p class="fine">The prototype runs on your device using pixel statistics. Production would use a vision model behind the same interface.</p>
  </section>`;
}

async function scanSample() {
  const pool = world.artworks.filter((a) => !a.image);
  const w = pool[Math.floor(rng() * pool.length)];
  const url = URL.createObjectURL(new Blob([artSVG(w)], { type: 'image/svg+xml' }));
  await runScan(url, `Sample: “${w.title}” (${w.style})`);
  URL.revokeObjectURL(url);
}

// ——— Profile ———
function renderProfile(root) {
  const liked = collectionIds('liked');
  const collected = collectionIds('saved');
  const top20 = new Set(world.topArtworks().filter((r) => r.rank != null).slice(0, BADGE_RULES.trendSetterTopN).map((r) => r.item.id));
  const trendHits = [...liked, ...collected].filter((id) => top20.has(id)).length;
  const myBadges = userBadges({ role: state.user.role, collectedCount: collected.length + state.purchases.length, reviewCount: state.reviews.length, trendHits });
  const myArtist = world.artistById[myArtistId()];
  const allBadges = [...myBadges, ...(myArtist ? world.badgesOf(myArtist) : [])];
  const tasteTop = topStyles(state.taste, 5);
  const tasteTotal = tasteTop.reduce((s, k) => s + state.taste.styles[k], 0) || 1;
  const followed = Object.keys(state.follows).map((id) => world.artistById[id]).filter(Boolean);
  const myWorks = world.artworks.filter(isMine).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  // Community mode: analytics are free for every artist until subscriptions are verified on the server
  // (Phase 6). Demo mode keeps the on-device plan preview.
  const canAnalyze = true; // studio insights are free on every plan

  root.innerHTML = `<div class="shell profile">
    ${accountCard()}
    ${installCard()}
    <header class="profile-hero">
      <span class="avatar avatar-xl avatar-me">${esc(initials(state.user.name))}</span>
      <div class="profile-id">
        <p class="eyebrow">${role().label} · vote weight ×${role().weight}</p>
        <label class="field field-bare"><span class="sr-only">Display name</span><input id="name" value="${esc(state.user.name)}" maxlength="40"></label>
        ${Select('country', COUNTRIES.map((c) => ({ value: c.code, label: c.name })), state.user.country, 'Country')}
      </div>
    </header>

    <dl class="stat-row stat-row-6">
      <div><dt>Liked</dt><dd>${liked.length}</dd></div>
      <div><dt>Saved</dt><dd>${collected.length}</dd></div>
      <div><dt>Following</dt><dd>${followed.length}</dd></div>
      <div><dt>Battles</dt><dd>${state.battles.voted}</dd></div>
      <div><dt>Reviews</dt><dd>${state.reviews.length}</dd></div>
      <div><dt>Acquired</dt><dd>${state.purchases.length}</dd></div>
    </dl>

    <div class="dash-grid profile-culture">
      ${tasteCardHTML(myTaste())}
      <div id="streak-slot" class="streak-slot">${streakCardHTML()}</div>
      <section class="panel influence-panel">
        <p class="eyebrow">Cultural Influence</p>
        <p class="influence-total">${fmt(personalInfluence(state.interactions, state.interactionRoles, state.reviews))}</p>
        <p class="muted">The weight your likes, Treasures and reviews add to the rankings. As a ${role().label.toLowerCase()}, each like adds ${role().weight}.</p>
      </section>
    </div>

    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Recognition', title: 'Achievements' })}
      <div class="achievement-grid">${(() => {
        const earned = new Set(myAchievements());
        return Object.entries(achievementCatalog()).filter(([k, a]) => earned.has(k) || (!k.startsWith('season_') && (!COMMUNITY || a.audience === 'member' || state.user.role === 'artist'))).map(([k, a]) => `<div class="achievement-card${earned.has(k) ? ' is-earned' : ''}">
          <span class="achievement-mark">${earned.has(k) ? AbremiSymbol(18) : Icon('lock', { size: 16 })}</span>
          <b>${esc(a.label)}</b><small>${esc(a.desc)}</small></div>`).join('');
      })()}</div>
    </section>

    <div class="profile-grid">
      <section class="panel">
        <h3 class="sub-head">Role</h3>
        <div class="role-grid">${ROLES.map((r) => `<button class="role-card${r.id === state.user.role ? ' is-on' : ''}" data-act="set-role" data-v="${r.id}" aria-pressed="${r.id === state.user.role}">
          <span class="role-top"><b>${r.label}</b><span class="role-weight">×${r.weight}</span></span><small>${esc(r.blurb)}</small>
          ${COMMUNITY && (r.id === 'critic' || r.id === 'collector') && r.id !== state.user.role ? roleStatusLabel(r.id) : ''}</button>`).join('')}</div>
        <p class="fine">${COMMUNITY ? 'Fan and Artist are open to everyone. Critic and Collector carry more weight, so they are granted after verification.' : 'Demo: switch roles freely. In production, Critic and Collector status requires verification.'}</p>
      </section>

      <section class="panel">
        <h3 class="sub-head">Badges</h3>
        <div class="badge-row">${allBadges.length ? allBadges.map((b) => `<span class="badge" title="${esc(BADGES[b].desc)}">${BADGES[b].emoji} ${BADGES[b].label}</span>`).join('') : '<span class="muted">None yet. Keep discovering.</span>'}</div>
        <details class="disclosure"><summary>How to earn badges ${Icon('chevron', { size: 16 })}</summary>${Object.values(BADGES).map((b) => `<p><b>${b.emoji} ${b.label}</b> ${esc(b.desc)}</p>`).join('')}</details>
        <h3 class="sub-head">Your taste</h3>
        ${tasteTop.length ? `<div class="meters">${tasteTop.map((k) => `<div class="meter-row"><span>${esc(k)}</span><div class="meter"><i style="width:${(state.taste.styles[k] / tasteTotal) * 100}%"></i></div><span class="num">${Math.round((state.taste.styles[k] / tasteTotal) * 100)}%</span></div>`).join('')}</div>
          <p class="fine">About ${Math.round(EXPLOIT_RATIO * 100)}% of your feed now comes from these movements. The rest keeps exploring.</p>` : '<p class="muted">Swipe a few works and your feed starts learning.</p>'}
      </section>
    </div>

    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Collection', title: 'Saved works', action: collected.length ? `<a class="link-arrow" href="#collections">All collections ${Icon('arrow', { size: 16 })}</a>` : '' })}
      ${collected.length ? ArtworkGrid(collected.slice(0, 8).map((id) => card(world.artworkById[id]))) : EmptyState({ icon: 'bookmark', title: 'Your collection is empty', body: 'Swipe up or tap Save on any work.', action: '<a class="btn btn-secondary" href="#discover"><span>Start discovering</span></a>' })}
    </section>

    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Following', title: 'Artists you follow' })}
      ${followed.length ? `<div class="artist-grid">${followed.map((a) => ArtistCard(a, { cover: coverOf(a.id), following: true, rank: world.globalArtistRanks[a.id] })).join('')}</div>` : EmptyState({ icon: 'user', title: 'Not following anyone yet', body: 'Follow artists to subscribe to their journey.' })}
    </section>

    ${state.user.role === 'artist' ? studioHTML(myWorks, canAnalyze) : ''}

    ${membershipCardHTML(member.mine, { community: COMMUNITY })}

    <div class="profile-foot">${PremiumButton('About Abremi', { act: 'about', variant: 'ghost' })}${COMMUNITY && me ? PremiumButton('Your interests', { act: 'interests-open', variant: 'ghost' }) : ''}${COMMUNITY ? PremiumButton('Send feedback', { act: 'feedback-open', variant: 'ghost' }) : ''}${PremiumButton('Reset demo data', { act: 'reset', variant: 'ghost', attrs: 'data-danger' })}</div>
  </div>`;

  $('#public-leaderboards', root)?.addEventListener('change', (e) => {
    state.user.publicLeaderboards = e.target.checked;
    commit();
    memberCache.clear();
    remote(() => cloud.updateProfile({ public_leaderboards: e.target.checked }));
    toast(e.target.checked ? 'You appear on member leaderboards' : 'You no longer appear on member leaderboards', { force: true });
  });
  $('#name', root).addEventListener('change', (e) => {
    state.user.name = e.target.value.trim().slice(0, 40) || 'You';
    commit();
    remote(() => cloud.updateProfile({ name: state.user.name }));
    renderView();
  });
  $('#country', root).addEventListener('change', (e) => {
    state.user.country = e.target.value;
    commit();
    remote(() => cloud.updateProfile({ country: state.user.country }));
    toast(`You’re now on the ${countryName(e.target.value)} leaderboard`);
    renderView();
  });
  const form = $('#upload', root);
  if (form) {
    form.addEventListener('submit', onUpload);
    $('input[type=file]', form).addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      $('#upload-name').textContent = file?.name || 'JPG, PNG or HEIC, up to 30 MB';
      const preview = $('#upload-preview');
      if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);
      if (file && /^image\//.test(file.type)) {
        preview.dataset.url = URL.createObjectURL(file);
        preview.src = preview.dataset.url;
        preview.hidden = false;
      } else preview.hidden = true;
      setUploadStatus('');
    });
  }
}

let uploading = false;

function studioHTML(myWorks, canAnalyze) {
  const where = COMMUNITY ? 'Published works are visible to everyone and enter the rankings and Art Battles straight away.' : 'Demo mode: your works are saved on this device only.';
  return `<section class="section section-tight" id="studio">
    ${SectionHeader({ eyebrow: 'Studio', title: 'Your work', action: COMMUNITY && me ? `<div class="studio-links"><a class="link-arrow" href="#studio">${Icon('chart', { size: 14 })} Analytics</a><a class="link-arrow" href="#inbox">${Icon('mail', { size: 14 })} Inbox</a><a class="link-arrow" href="#coach">${Icon('pen', { size: 14 })} Coach</a><button class="link-arrow" data-act="exhibitions-open">${Icon('check', { size: 14 })} Passport</button><button class="link-arrow" data-act="open-drop-form">${Icon('clock', { size: 14 })} Schedule a drop</button><button class="link-arrow" data-act="edit-artist-profile">${Icon('pen', { size: 14 })} Artist profile</button>${world.artistById[myArtistId()] ? `<a class="link-arrow" href="#artist/${encodeURIComponent(myArtistId())}">Your page ${Icon('arrow', { size: 14 })}</a>` : ''}</div>` : '' })}
    <div class="profile-grid">
      <form id="upload" class="panel upload" novalidate>
        <label class="dropzone dropzone-sm">
          <input type="file" name="file" accept="image/*">
          <img id="upload-preview" class="upload-preview" alt="" hidden>
          ${Icon('plus', { size: 22 })}<b>Choose a photo of your work</b><small id="upload-name">JPG, PNG or HEIC, up to 30 MB</small>
        </label>
        <label class="field"><span>Title</span><input name="title" maxlength="60" autocomplete="off"></label>
        <div class="field-row">
          <label class="field"><span>Medium</span><select name="category">${CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Movement</span><select name="style">${STYLES.map((x) => `<option>${x}</option>`).join('')}</select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Year</span><input name="year" type="number" inputmode="numeric" min="1900" max="2100" value="${CURRENT_YEAR}"></label>
          <label class="field"><span>Price (USD)</span><input name="price" type="number" inputmode="numeric" min="${PRICE_MIN}" step="10" placeholder="500"></label>
        </div>
        ${COMMUNITY ? `<div class="field-row">
          <label class="field"><span>Size (optional)</span><input name="dimensions" maxlength="60" placeholder="60 × 80 cm"></label>
          <label class="field"><span>Availability</span><select name="availability">${Object.entries(AVAILABILITY).filter(([k]) => k !== 'sold').map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Description (optional)</span><textarea name="description" rows="3" maxlength="2000" placeholder="The story behind the work."></textarea></label>` : ''}
        <p class="upload-status" id="upload-status" role="status" aria-live="polite"></p>
        <button class="btn btn-primary btn-block" id="upload-submit">${COMMUNITY ? 'Publish to Abremi' : 'Publish work'}</button>
        <p class="fine">${where} Photos are resized and their hidden data (such as location) is removed before upload.</p>
      </form>
      <div class="panel">
        ${myWorks.length ? `<ol class="rank-list">${myWorks.map((w) => {
          const c = world.countsOf(w);
          const detail = canAnalyze ? ROLES.map((r) => `${r.label} ${c.likes[r.id] + c.saves[r.id]}`).join(' · ') : 'Who liked this · Pro';
          return `<li class="work-row"><button class="rank-row" data-act="artwork" data-id="${w.id}"><span class="rank-thumb">${ArtImage(w)}</span><span class="rank-text"><b>${esc(w.title)}</b><small>${detail}</small></span><span class="rank-score">${fmt(world.influence[w.id])}</span></button>
            ${IconButton('x', `Delete ${w.title}`, { act: 'delete-artwork', attrs: `data-id="${w.id}"` })}</li>`;
        }).join('')}</ol>` : EmptyState({ icon: 'grid', title: 'No works yet', body: 'Your published works appear here, with who liked them.' })}
      </div>
    </div>
  </section>`;
}

function setUploadStatus(text, kind = '') {
  const el = $('#upload-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

async function onUpload(e) {
  e.preventDefault();
  if (uploading) return;
  const form = e.target;
  const fd = new FormData(form);
  const file = fd.get('file');
  const meta = {
    title: String(fd.get('title') || '').trim(),
    category: fd.get('category'),
    style: fd.get('style'),
    price: Number(fd.get('price')),
    year: Number(fd.get('year')) || CURRENT_YEAR,
  };
  if (!file || !file.size) return setUploadStatus('Choose a photo of your work first.', 'error');
  const errors = validateUpload({ ...meta, fileType: file.type, fileSize: file.size });
  if (errors.length) return setUploadStatus(errors[0], 'error');
  if (COMMUNITY && !me) return openSignIn();

  uploading = true;
  const button = $('#upload-submit');
  button.disabled = true;
  let prepared;
  try {
    setUploadStatus('Preparing your image…');
    prepared = await prepareImage(file);
    const medium = categoryById[meta.category].medium;
    if (COMMUNITY) {
      setUploadStatus('Uploading…');
      const published = await cloud.publishArtwork({ ...prepared, ...meta, medium });
      const extra = {
        description: String(fd.get('description') || '').trim(),
        dimensions: String(fd.get('dimensions') || '').trim(),
        availability: String(fd.get('availability') || 'available'),
      };
      if (published?.id && (extra.description || extra.dimensions || extra.availability !== 'available')) {
        await cloud.updateArtwork(published.id, { ...meta, medium, ...extra }).catch(() => toast('Published, but the description could not be saved. Edit the work to add it.'));
      }
      await refreshCommunity();
      toast('Published. Your work is live for everyone.', { force: true });
    } else {
      // Demo mode keeps the work on this device, so keep it small enough for local storage.
      const image = await blobToDataURL(prepared.image.size < 900_000 ? prepared.image : prepared.thumb);
      const thumb = await blobToDataURL(prepared.thumb);
      state.uploads.push({
        id: `u${Date.now()}`,
        title: meta.title,
        artistId: 'me',
        category: meta.category,
        style: meta.style,
        medium,
        year: meta.year,
        price: meta.price,
        quality: 0.5,
        palette: PALETTES[0],
        image,
        thumb,
        width: prepared.width,
        height: prepared.height,
        counts: { likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } },
        elo: START_RATING,
        at: Date.now(),
        createdAt: Date.now(),
      });
      commit();
      toast('Published. Your work is now in the rankings and battles.', { force: true });
    }
    renderView();
  } catch (err) {
    const msg = err?.message || '';
    setUploadStatus(/decode|read|source/i.test(msg) ? 'That image could not be read. Try a JPG or PNG.' : /quota|storage is full/i.test(msg) ? 'This device is out of space for demo uploads.' : msg || 'Upload failed. Check your connection and try again.', 'error');
  } finally {
    uploading = false;
    if (prepared?.previewURL) URL.revokeObjectURL(prepared.previewURL);
    const b = $('#upload-submit');
    if (b) b.disabled = false;
  }
}

async function deleteArtwork(id) {
  const w = world.artworkById[id];
  if (!w || !isMine(w)) return;
  if (!confirm(`Delete “${w.title}”? Its likes, saves and battle rating go with it.`)) return;
  try {
    if (COMMUNITY) {
      await cloud.deleteArtwork(id);
      await refreshCommunity();
    } else {
      state.uploads = state.uploads.filter((u) => u.id !== id);
      delete state.deltas[id];
      delete state.interactions[id];
      delete state.elo[id];
      commit();
    }
    deck = deck.filter((d) => d.artwork.id !== id);
    if (sheetRenderer) closeSheet();
    toast(`Deleted “${w.title}”`, { force: true });
    renderView();
  } catch (e) {
    toast(e?.message || 'Could not delete that work.', { force: true });
  }
}

function aboutSheet() {
  return aboutHTML({ roles: ROLES, community: COMMUNITY });
}

// ——— Search ———
function openSearch() {
  const s = $('#search');
  lastFocus = document.activeElement;
  $('#search-body').innerHTML = `${SearchBar()}<div id="search-results" class="search-results">${searchResultsHTML('')}</div>`;
  s.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => { s.classList.add('open'); $('#search-input').focus(); });
  $('#search-input').addEventListener('input', (e) => { $('#search-results').innerHTML = searchResultsHTML(e.target.value); });
}

function closeSearch() {
  const s = $('#search');
  if (s.hidden) return;
  s.classList.remove('open');
  if (!sheetRenderer) document.body.classList.remove('modal-open');
  setTimeout(() => { if (!s.classList.contains('open')) s.hidden = true; }, 200);
}

function searchResultsHTML(q) {
  const query = q.trim().toLowerCase();
  if (!query) {
    return `<p class="eyebrow">Browse movements</p><div class="chip-row chip-row-wrap">${STYLES.map((s) => `<button class="chip" data-act="search-term" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <p class="eyebrow">Mediums</p><div class="chip-row chip-row-wrap">${CATEGORIES.map((c) => `<button class="chip" data-act="search-term" data-v="${esc(c.label)}">${esc(c.label)}</button>`).join('')}</div>`;
  }
  const hit = (s) => String(s).toLowerCase().includes(query);
  const works = world.topArtworks().map((r) => r.item).filter((w) => hit(w.title) || hit(w.style) || hit(w.medium) || hit(categoryById[w.category].label) || hit(artistOf(w).name)).slice(0, 8);
  const artists = world.topArtists().map((r) => r.item).filter((a) => hit(a.name) || hit(countryName(a.country))).slice(0, 6);
  if (!works.length && !artists.length) return EmptyState({ icon: 'search', title: `No results for “${q.trim()}”`, body: 'Try a movement, medium, artist or country.' });
  return `${artists.length ? `<p class="eyebrow">Artists</p><ol class="rank-list">${artists.map((a) => `<li><button class="rank-row" data-act="search-open" data-kind="artist" data-id="${a.id}">${Avatar(a, 'md')}<span class="rank-text"><b>${esc(a.name)}</b><small>${esc(countryName(a.country))}</small></span>${Icon('arrow', { size: 16 })}</button></li>`).join('')}</ol>` : ''}
    ${works.length ? `<p class="eyebrow">Works</p><ol class="rank-list">${works.map((w) => `<li><button class="rank-row" data-act="search-open" data-kind="artwork" data-id="${w.id}"><span class="rank-thumb">${ArtImage(w)}</span><span class="rank-text"><b>${esc(w.title)}</b><small>${esc(artistOf(w).name)} · ${esc(w.style)}</small></span>${Icon('arrow', { size: 16 })}</button></li>`).join('')}</ol>` : ''}`;
}

// ——— Notifications (derived from your own activity; nothing invented) ———
let serverNotifications = [];
async function loadNotifications() {
  if (!cloud?.notifications || !me) return;
  try {
    serverNotifications = await cloud.notifications();
    updateNotificationDot();
    if (!$('#notifications').hidden) renderNotifications(); // arrived while the list is open
  } catch { /* older database */ }
}
function notifications() {
  const items = serverNotifications.map((n) => ({ at: Date.parse(n.created_at) || 0, text: esc(n.title), act: 'open-link', id: n.link || '' }));
  for (const a of state.applications || []) {
    if (a.status !== 'approved' && a.status !== 'declined') continue;
    const label = a.role === 'critic' ? 'Critic' : 'Collector';
    items.push({ at: Date.parse(a.decided_at) || 0, text: a.status === 'approved' ? `Your <b>${label}</b> application was approved` : `Your <b>${label}</b> application was declined${a.decision_note ? `: ${esc(a.decision_note)}` : ''}`, act: 'goto-profile', id: a.role });
  }
  // Today's Daily Masterpiece, revealed at local midnight.
  const mp = todaysMasterpiece()?.artwork;
  if (mp) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    items.push({ at: midnight.getTime(), text: `Today’s Daily Masterpiece: <b>${esc(mp.title)}</b>`, act: 'artwork', id: mp.id });
  }
  const prev = state.snapshot?.prev?.artist;
  const hourAt = (state.snapshot?.hour || hourKey()) * 3_600_000;
  for (const id of Object.keys(state.follows)) {
    const a = world.artistById[id];
    const cur = world.globalArtistRanks[id];
    const before = prev?.[id];
    if (a && before && cur && before !== cur) items.push({ at: hourAt, text: `<b>${esc(a.name)}</b> moved ${before > cur ? 'up' : 'down'} to No. ${cur} worldwide`, act: 'artist', id });
  }
  for (const p of state.purchases) { const w = world.artworkById[p.artworkId]; if (w) items.push({ at: p.at, text: `You acquired <b>${esc(w.title)}</b>`, act: 'artwork', id: w.id }); }
  for (const r of state.reviews) { const w = world.artworkById[r.artworkId]; if (w) items.push({ at: r.at, text: `Your ${r.rating}★ review of <b>${esc(w.title)}</b> is live`, act: 'artwork', id: w.id }); }
  for (const m of state.messages) { const a = world.artistById[m.artistId]; if (a) items.push({ at: m.at, text: `${m.text === '[sponsorship request]' ? 'Sponsorship request' : 'Inquiry'} sent to <b>${esc(a.name)}</b>`, act: 'artist', id: a.id }); }
  for (const u of state.uploads) { const w = world.artworkById[u.id]; if (w) items.push({ at: u.at || 0, text: `<b>${esc(w.title)}</b> is live in the rankings`, act: 'artwork', id: w.id }); }
  return items.sort((x, y) => y.at - x.at).slice(0, 12);
}

function updateNotificationDot() {
  $('#notif-dot').hidden = !notifications().some((n) => n.at > (state.notifSeenAt || 0));
}

function renderNotifications() {
  const items = notifications();
  $('#notifications').innerHTML = `<p class="popover-title">Notifications</p>${items.length
    ? items.map((n) => `<button class="notif" role="menuitem" data-act="${n.act}" data-id="${n.id}"><span>${n.text}</span><small>${new Date(n.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></button>`).join('')
    : `<div class="popover-empty">${Icon('bell', { size: 22 })}<p>Follow artists, review, or acquire a work. Updates appear here.</p></div>`}`;
}

function togglePopover(id, btn) {
  const pop = $(`#${id}`);
  const open = pop.hidden;
  closePopovers();
  if (!open) return;
  if (id === 'notifications') {
    renderNotifications();
    state.notifSeenAt = Date.now();
    saveState(state);
    if (serverNotifications.some((n) => !n.read_at)) cloud?.markNotificationsRead?.().catch(() => {});
    $('#notif-dot').hidden = true;
  }
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => pop.classList.add('open'));
}

function closePopovers() {
  $$('.popover').forEach((p) => { p.classList.remove('open'); p.hidden = true; });
  $$('[aria-haspopup]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

// ——— Critic & Collector applications ———
const ROLE_GUIDE = {
  critic: {
    label: 'Critic',
    lookFor: ['Published criticism, reviews or essays about art', 'Curatorial, editorial or teaching experience', 'A portfolio or byline we can check'],
    prompt: 'Where has your writing about art appeared? What do you cover, and for how long?',
  },
  collector: {
    label: 'Collector',
    lookFor: ['A collection you have built over time', 'Acquisitions from galleries, fairs, auctions or artists', 'Anything that lets us verify it: a collection site, press or gallery references'],
    prompt: 'What do you collect, and how did you build your collection?',
  },
};

const latestApplication = (role) => (state.applications || []).find((a) => a.role === role);

function roleStatusLabel(role) {
  const app = latestApplication(role);
  if (app?.status === 'pending') return '<span class="role-lock is-pending">Application pending</span>';
  if (app?.status === 'declined') return '<span class="role-lock is-declined">Declined · apply again</span>';
  return '<span class="role-lock">Apply for verification</span>';
}

function applySheet(role) {
  const g = ROLE_GUIDE[role];
  const app = latestApplication(role);
  if (app?.status === 'pending') {
    return `<div class="auth"><p class="eyebrow">${g.label} application</p><h2 class="display-md" id="modal-title">Under review</h2>
      <p class="muted">Sent ${new Date(app.created_at).toLocaleDateString([], { month: 'long', day: 'numeric' })}. You will see the decision here and in your notifications.</p>
      <div class="detail-actions">${PremiumButton('Withdraw application', { act: 'withdraw-application', variant: 'ghost', attrs: `data-id="${app.id}"` })}</div></div>`;
  }
  return `<form class="auth apply-form" id="apply-form" novalidate>
    <p class="eyebrow">Apply for verification</p>
    <h2 class="display-md" id="modal-title">Become a ${g.label}</h2>
    <p class="muted">${g.label}s’ votes count ×${ROLE_WEIGHTS[role]}, so every application is reviewed by a person.</p>
    ${app?.status === 'declined' ? `<p class="apply-declined"><b>Your last application was declined.</b>${app.decision_note ? ` ${esc(app.decision_note)}` : ''}</p>` : ''}
    <div class="apply-guide"><small>What we look for</small><ul>${g.lookFor.map((x) => `<li>${Icon('check', { size: 14 })}${esc(x)}</li>`).join('')}</ul></div>
    <label class="field"><span>${esc(g.prompt)}</span><textarea id="apply-statement" rows="6" maxlength="1500" placeholder="40 characters or more"></textarea><small class="char-count" id="apply-count">0 / 1500</small></label>
    <label class="field"><span>Links (optional, one per line, up to 5)</span><textarea id="apply-links" rows="3" placeholder="https://"></textarea></label>
    <label class="check"><input type="checkbox" id="apply-honest"> Everything here is accurate, and I won’t use the role to manipulate rankings.</label>
    <p class="form-error" id="apply-error" role="alert" hidden></p>
    <div class="detail-actions">${PremiumButton('Send application', { act: 'apply-role', attrs: `data-v="${role}"` })}</div>
    <p class="fine">Reviewers see your application, your display name, email and your activity on Abremi. You can apply three times every 30 days.</p>
  </form>`;
}

async function sendApplication(role) {
  const statement = ($('#apply-statement')?.value || '').trim();
  const links = ($('#apply-links')?.value || '').split(/\s+/).map((l) => l.trim()).filter(Boolean);
  const error = (msg) => { const e = $('#apply-error'); e.textContent = msg; e.hidden = false; };
  if (statement.length < 40) return error('Tell us a little more: at least 40 characters.');
  if (links.length > 5) return error('Add at most five links.');
  if (links.some((l) => !/^https:\/\/\S{4,}$/.test(l))) return error('Links must start with https://');
  if (!$('#apply-honest')?.checked) return error('Please confirm that everything is accurate.');
  try {
    await cloud.applyForRole(role, statement, links);
    state.applications = await cloud.myApplications();
    commit();
    closeSheet();
    toast(`Application sent. We’ll review it and let you know here.`, { force: true, duration: 4000 });
    renderView();
  } catch (e) {
    error(e?.message || 'Could not send your application. Try again.');
  }
}

// ——— Admin: review applications (only reachable when the server says you are an admin) ———
let adminData = null;
async function loadAdmin() {
  try {
    const [queue, verified, flags, audit, , reports, exQueue, oppQueue, galleries, holders, invites, feedback, errors, guideStats, disputes] = await Promise.all([
      cloud.adminQueue(), cloud.verifiedMembers(),
      cloud.integrityQueue ? cloud.integrityQueue().catch(() => []) : [],
      cloud.auditLog ? cloud.auditLog().catch(() => []) : [],
      loadArena(true),
      cloud.inquiryReports ? cloud.inquiryReports().catch(() => []) : [],
      cloud.exhibitionQueue ? cloud.exhibitionQueue().catch(() => []) : [],
      cloud.opportunityQueue ? cloud.opportunityQueue().catch(() => []) : [],
      cloud.galleryQueue ? cloud.galleryQueue().catch(() => []) : [],
      cloud.planHolders ? cloud.planHolders().catch(() => []) : [],
      cloud.invites ? cloud.invites().catch(() => null) : null,
      cloud.feedbackQueue ? cloud.feedbackQueue().catch(() => []) : [],
      cloud.clientErrors ? cloud.clientErrors(7).catch(() => []) : [],
      cloud.guideMetrics ? cloud.guideMetrics(30).catch(() => null) : null,
      cloud.disputes ? cloud.disputes().catch(() => []) : [],
    ]);
    adminData = { queue, verified, flags, audit, reports, exQueue, oppQueue, galleries, holders, invites, feedback, errors, guide: guideStats, disputes, at: Date.now() };
  } catch (e) {
    adminData = { error: e?.message || 'Could not load applications.' };
  }
  if (currentView() === 'admin') renderView();
}

function renderAdmin(root) {
  if (!COMMUNITY || !me || !isAdmin) {
    root.innerHTML = `<div class="shell">${EmptyState({ icon: 'lock', title: 'Moderators only', body: 'This page is for Abremi moderators.', action: '<a class="btn btn-secondary" href="#home"><span>Back home</span></a>' })}</div>`;
    return;
  }
  if (adminData?.at && Date.now() - adminData.at > 15_000 && !adminData.refreshing) { adminData.refreshing = true; setTimeout(loadAdmin, 0); } // coming back: refresh in place
  if (!adminData) { setTimeout(loadAdmin, 0); root.innerHTML = `<div class="shell"><header class="page-head"><h1 class="display-lg">Applications</h1></header>${LoadingSkeleton({ cards: 3, variant: 'list' })}</div>`; return; }
  if (adminData.error) { root.innerHTML = `<div class="shell">${EmptyState({ title: 'Could not load applications', body: adminData.error, action: PremiumButton('Try again', { act: 'admin-reload', variant: 'secondary' }) })}</div>`; return; }
  const running = (arena.list || []).filter((c) => ['upcoming', 'entries', 'voting'].includes(c.phase));
  const competitionSection = `<section class="section section-tight" id="admin-competitions">${SectionHeader({ eyebrow: 'Artist Arena', title: 'Create a competition' })}
      ${createCompetitionForm(arena.adminKind)}
      ${running.length ? `<h3 class="sub-head">Running now</h3><div class="competition-list">${running.map((c) => `<div class="admin-competition">${competitionCard(c, { cover: coverThumb })}${PremiumButton('Cancel', { act: 'cancel-competition', variant: 'ghost', attrs: `data-v="${c.id}" data-danger` })}</div>`).join('')}</div>` : ''}
    </section>`;
  const v = lazyPage(root, 'admin');
  if (!v) return;
  root.innerHTML = v.adminPage(adminData, { roleLabel: (r) => ROLE_GUIDE[r]?.label || r, competitionSection, planSearch: member.planSearch });
}

// ——— Install as an app ———
const installCard = () => installCardHTML(pwa?.status());
const iosInstallSheet = () => iosInstallHTML(location.host);

// ——— Accounts & community sync ———
function refreshSheet() {
  if (sheetRenderer) $('#sheet-body').innerHTML = sheetRenderer();
}

function openSignIn() {
  if (!COMMUNITY) return;
  if (!cloud) return toast('Connecting to Abremi… try again in a moment.');
  if (me) { location.hash = 'profile'; return; }
  Object.assign(auth, { error: '', busy: false });
  if (auth.stage !== 'sent') auth.stage = 'email';
  openSheet(signInSheet);
}

function signInSheet() {
  const local = Object.values(state.interactions).filter((k) => k === 'like' || k === 'super').length;
  return signInHTML({ auth, standalone: Boolean(pwa?.status().standalone), local, inviteRequired: Boolean(member.flags?.invite_required) });
}

async function sendLink() {
  const email = ($('#auth-email')?.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    Object.assign(auth, { error: 'Enter a valid email address.' });
    return refreshSheet();
  }
  const invite = ($('#auth-invite')?.value || '').trim().toUpperCase();
  Object.assign(auth, { email, invite, busy: true, error: '' });
  refreshSheet();
  try {
    if (invite && cloud.checkInvite && !(await cloud.checkInvite(invite))) throw new Error('That invite code isn’t valid. Check it, or ask for a new one.');
    await cloud.sendLink(email, invite);
    Object.assign(auth, { stage: 'sent', busy: false });
  } catch (e) {
    Object.assign(auth, { busy: false, error: /rate|seconds/i.test(e?.message || '') ? 'Too many emails requested. Wait a minute, then try again.' : e?.message || 'Could not send the email. Try again.' });
  }
  refreshSheet();
}

async function verifyCode() {
  const code = ($('#auth-code')?.value || '').replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(code)) {
    Object.assign(auth, { error: 'Enter the code from the email.' });
    return refreshSheet();
  }
  Object.assign(auth, { busy: true, error: '' });
  refreshSheet();
  try {
    const user = await cloud.verifyCode(auth.email, code);
    await signedIn(user);
  } catch (e) {
    Object.assign(auth, { busy: false, error: /expired|invalid/i.test(e?.message || '') ? 'That code is invalid or has expired.' : e?.message || 'Could not verify the code.' });
    refreshSheet();
  }
}

async function signedIn(user) {
  if (!user || me?.id === user.id) return;
  me = user;
  memberCache.clear();
  Object.assign(auth, { stage: 'email', busy: false, error: '' });
  closeSheet();
  try {
    const imported = await syncAccount({ importGuest: true });
    const moved = movedCollections ? ` ${movedCollections} collection${movedCollections === 1 ? '' : 's'} moved to your account.` : '';
    movedCollections = 0;
    toast(imported ? `Welcome. ${imported} item${imported === 1 ? '' : 's'} from this device added to your account.${moved}` : `Welcome to Abremi. Your votes now count.${moved}`, { force: true, duration: 3500 });
  } catch {
    toast('Signed in, but your account could not be loaded. Reload to try again.', { force: true });
  }
  await Promise.all([loadMembership().catch(() => {}), loadLoop()]);
  await loadSales();
  renderView();
}

async function signOut() {
  try { await cloud.signOut(); } catch { /* already signed out */ }
  signedOut();
  toast('Signed out', { force: true });
}

function signedOut() {
  me = null;
  memberCache.clear(); // leaderboards fetched while signed in include your private standing
  isAdmin = false;
  adminData = null;
  state.applications = [];
  state.collections = (state.collections || []).filter((c) => !c.server); // account collections stay with the account
  sharedCollections.clear();
  serverAchievements.earned = [];
  serverNotifications = [];
  Object.assign(radar, { list: null, scheduled: [] });
  Object.assign(careers, { usage: null, exhibitions: null });
  Object.assign(member, { mine: undefined, gallery: undefined, busy: '', planSearch: { query: '', results: null } });
  Object.assign(guide, { threads: { visitor: [], artist: [], collector: [] }, usage: null, prefs: null, error: null, loaded: false, view: 'chat' });
  Object.assign(loop, { watches: new Set(), interests: null, swipes: 0, loaded: false });
  Object.assign(sales, { payout: null, orders: null, busy: '' });
  idx.badge = undefined;
  careers.coach.result = null;
  threads.clear();
  Object.assign(studio, { data: undefined, reports: null, at: 0 });
  Object.assign(state, { interactions: {}, interactionRoles: {}, follows: {}, reviews: [], account: null });
  state.user = { ...state.user, role: 'fan', name: 'You' };
  deck = [];
  commit();
  renderView();
}

/** Load the member's profile and own rows; optionally add what they did as a guest first. */
async function syncAccount({ importGuest = false } = {}) {
  const profile = await cloud.profile();
  let mine = await cloud.mine();
  let imported = 0;
  if (importGuest) {
    const extra = guestContributions(state, mine, {
      artworkIds: new Set([...seed.artworks, ...(state.community?.artworks || [])].map((w) => w.id)),
      artistIds: new Set([...seed.artists, ...(state.community?.artists || [])].map((a) => a.id)),
    });
    imported = extra.reactions.filter((r) => r.kind !== 'pass').length + extra.follows.length;
    if (extra.reactions.length || extra.follows.length) {
      await cloud.importGuest(extra);
      mine = await cloud.mine();
    }
  }
  Object.assign(state, mineToState(mine));
  const roleBefore = state.account?.id === me.id ? state.user.role : null;
  state.user = { ...state.user, name: profile.name, country: profile.country, role: profile.role, publicLeaderboards: profile.public_leaderboards !== false };
  memberCache.clear();
  // Critic & Collector applications (older databases without the feature simply return none).
  await syncCollections();
  await Promise.all([loadAchievements(), loadNotifications(), loadInbox()]);
  const [apps, admin] = await Promise.all([cloud.myApplications().catch(() => []), cloud.isAdmin().catch(() => false)]);
  const before = new Map((state.applications || []).map((a) => [a.id, a.status]));
  state.applications = apps;
  isAdmin = admin;
  const decided = apps.find((a) => before.get(a.id) === 'pending' && (a.status === 'approved' || a.status === 'declined'));
  if (decided) {
    const label = decided.role === 'critic' ? 'Critic' : 'Collector';
    toast(decided.status === 'approved'
      ? `Your ${label} application was approved. Your votes now count ×${ROLE_WEIGHTS[decided.role]}.`
      : `Your ${label} application was declined${decided.decision_note ? `: ${decided.decision_note}` : '.'}`, { force: true, duration: 6000 });
  } else if (roleBefore && roleBefore !== profile.role && (roleBefore === 'critic' || roleBefore === 'collector')) {
    toast(`Your ${roleBefore === 'critic' ? 'Critic' : 'Collector'} status was removed by a moderator.`, { force: true, duration: 6000 });
  }
  state.account = { id: me.id, email: me.email };
  deck = [];
  await refreshCommunity();
  return imported;
}

/**
 * Collections live with the account. Collections made on this device before signing in move to the
 * account once (works that only exist on this device are left out). Databases without the
 * collections tables keep collections on the device.
 */
async function syncCollections() {
  let data;
  try { data = await cloud.myCollections(); } catch { return; }
  const local = (state.collections || []).filter((c) => !c.server);
  let moved = 0;
  for (const c of local) {
    try {
      const row = await cloud.createCollection({ name: c.name.slice(0, 60), isPrivate: c.private !== false });
      for (const id of c.ids.filter((x) => world.artworkById[x])) await cloud.addToCollection(row.id, id).catch(() => {});
      moved++;
    } catch { /* keep going: one bad name shouldn't stop the rest */ }
  }
  if (moved) data = await cloud.myCollections().catch(() => data);
  state.collections = collectionsToState(data.collections, data.items);
  movedCollections = moved; // mentioned in the welcome message
}
let movedCollections = 0;
const syncedCollections = () => COMMUNITY && me && cloud?.createCollection;

// Shared collections (#collection/<id>), fetched on demand.
const sharedCollections = new Map();
function renderSharedCollection(root) {
  const id = route().param;
  if (COMMUNITY && !cloud) { root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 6 })}</div>`; return; } // still connecting
  const own = me && state.account?.id === me.id ? state.collections.find((c) => c.id === id && c.server) : null;
  const entry = own
    ? { data: { id, name: own.name, description: own.description, is_private: own.private, owner_name: state.user.name, mine: true, items: own.ids } }
    : sharedCollections.get(id);
  if (!entry || (!entry.loading && Date.now() - entry.at > 10_000)) { // the curator may have changed it since
    sharedCollections.delete(id);
    sharedCollections.set(id, { loading: true });
    root.innerHTML = `<div class="shell">${LoadingSkeleton({ cards: 6 })}</div>`;
    (cloud?.publicCollection ? cloud.publicCollection(id) : Promise.resolve(null))
      .then((data) => sharedCollections.set(id, { data, at: Date.now() }))
      .catch(() => sharedCollections.set(id, { data: null, error: true, at: Date.now() }))
      .finally(() => { if (route().name === 'collection' && route().param === id) renderView(); });
    return;
  }
  if (entry.loading) return;
  const c = entry.data;
  if (!c) {
    root.innerHTML = `<div class="shell">${EmptyState({ icon: 'lock', title: entry.error ? 'Could not load this collection' : 'This collection is private', body: entry.error ? 'Check your connection and try again.' : 'Only its curator can see it. They may have made it private.', action: '<a class="btn btn-secondary" href="#collections"><span>Collections</span></a>' })}</div>`;
    return;
  }
  const works = (c.items || []).map((x) => world.artworkById[x]).filter(Boolean);
  root.innerHTML = `<div class="shell shared-collection">
    <header class="page-head"><p class="eyebrow">${c.is_private ? `${Icon('lock', { size: 12 })} Private collection` : 'Collection'} · curated by ${esc(c.owner_name || 'a member')}</p>
      <h1 class="display-lg">${esc(c.name)}</h1>${c.description ? `<p class="lede">${esc(c.description)}</p>` : ''}
      <div class="detail-actions">${!c.is_private ? PremiumButton('Share', { act: 'share-collection', variant: 'secondary', icon: 'share', attrs: `data-v="${esc(c.id)}"` }) : ''}
        ${c.mine ? PremiumButton('Edit', { act: 'edit-collection', variant: 'ghost', icon: 'pen', attrs: `data-v="${esc(c.id)}"` }) : ''}</div></header>
    ${works.length ? ArtworkGrid(works.map((w) => card(w))) : EmptyState({ icon: 'folderPlus', title: 'No works here yet' })}
  </div>`;
}

async function refreshCommunity() {
  if (!cloud) return;
  if (pendingWrites > 0) return; // don't overwrite changes still on their way to the server
  const snap = await cloud.snapshot();
  if (pendingWrites > 0) return;
  state.community = snapshotToCommunity(snap, Date.now(), { storageBase: cloud.storageBase || '' });
  commit();
}

/** After a failed write, reload what the server actually has. */
async function resync() {
  if (!cloud) return;
  try {
    if (me) await syncAccount();
    else await refreshCommunity();
  } catch { /* offline: keep what we have */ }
  refresh();
}

async function connectCommunity() {
  if (!COMMUNITY) return;
  try {
    cloud = window.__abremiCloud ? await window.__abremiCloud() : await createSupabaseCloud(SUPABASE_URL, SUPABASE_ANON_KEY);
    const hadTokens = /access_token|error_description/.test(location.hash);
    const errorText = hadTokens ? new URLSearchParams(location.hash.slice(1)).get('error_description') : null;
    const user = await cloud.init();
    if (hadTokens) history.replaceState(null, '', `${location.pathname}${location.search}#home`);
    if (errorText) toast(/expired/i.test(errorText) ? 'That sign-in link has expired. Request a new one.' : errorText, { duration: 5000 });
    if (user) {
      const switched = state.account && state.account.id !== user.id;
      me = user;
      await syncAccount({ importGuest: !state.account || switched });
      if (hadTokens) toast('Welcome to Abremi. Your votes now count.');
    } else {
      if (state.account) signedOut(); // session expired elsewhere
      await refreshCommunity();
    }
    cloud.onAuth((u, event) => {
      if (event === 'SIGNED_OUT' && me) signedOut();
      else if (u && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && me?.id !== u.id) signedIn(u);
    });
  } catch (e) {
    console.warn('Abremi community unavailable', e);
    toast('Community rankings are offline. Showing the last ones saved.', { duration: 4000 });
  }
  await Promise.all([loadChartBaseline(), me ? null : loadAchievements(), loadMembership().catch(() => {}), loadLoop()]);
  await loadSales();
  if (!sheetRenderer) renderView();
  else refresh();
  setInterval(quietRefresh, 90_000);
  document.addEventListener('visibilitychange', quietRefresh);
  // Live updates: the database bumps a public pulse when anything changes; refetch the totals.
  cloud?.onPulse?.(onPulse, (connected) => {
    if (live === connected) return;
    live = connected;
    const s = $('#chart-status');
    if (s) s.outerHTML = chartStatusHTML(new Date());
  });
}

/** Background refresh: keeps totals (and pending applications) current without interrupting the person. */
function quietRefresh() {
  if (document.hidden || !cloud) return;
  const waiting = me && state.applications?.some((a) => a.status === 'pending');
  Promise.all([waiting ? syncAccount() : refreshCommunity(), loadChartBaseline(), waiting ? null : loadAchievements(), waiting ? null : loadNotifications(), loadArena(), waiting ? null : loadInbox(), loadDrops(true)])
    .then(() => {
      // A decided application changes the member's role, so every view (and the nav badge) must redraw.
      if (waiting) commit();
      const passive = waiting || ['home', 'charts', 'explore', 'artists', 'collections'].includes(currentView());
      if (passive && !sheetRenderer && !document.activeElement?.matches('input, textarea, select')) renderView();
    })
    .catch(() => {});
}

// Someone, somewhere, liked, followed, voted or uploaded. Wait a moment so a burst arrives as one
// refresh, and refresh at most every 5 seconds so a busy site doesn't keep redrawing the page.
let pulseTimer = null;
let lastPulseRefresh = 0;
function onPulse() {
  if (pulseTimer) return;
  const delay = Math.max(1500, lastPulseRefresh + 5000 - Date.now());
  pulseTimer = setTimeout(() => { pulseTimer = null; lastPulseRefresh = Date.now(); quietRefresh(); }, delay);
}

const accountCard = () => accountCardHTML({ community: COMMUNITY, me, members: state.community?.members || 0, publicLeaderboards: state.user.publicLeaderboards !== false, isAdmin });

// ——— Actions ———
const ACTIONS = {
  swipe: (el) => decide(el.dataset.dir),
  react: (el) => react(world.artworkById[el.dataset.id], el.dataset.v),
  artwork: (el) => { closePopovers(); trackArtwork('artwork_view', el.dataset.id); openSheet(() => artworkSheet(el.dataset.id), { wide: true }); },
  artist: (el) => { closePopovers(); openArtist(el.dataset.id); },
  back: () => (history.length > 1 ? history.back() : (location.hash = 'artists')),
  'artist-tab': (el) => { artistTab = el.dataset.v; renderView(); },
  'how-ranked': () => openSheet(howRankedSheet),
  'coach-tool': (el) => { Object.assign(careers.coach, { tool: el.dataset.v, error: '' }); renderView(); },
  'coach-run': async () => {
    const c = careers.coach;
    c.artworkId = $('#coach-artwork')?.value || c.artworkId;
    c.opportunityId = $('#coach-opportunity')?.value || c.opportunityId;
    Object.assign(c, { busy: true, error: '' });
    renderView();
    try {
      c.result = await cloud.coach(c.tool, { artworkId: lazyModules.careers.COACH_TOOLS[c.tool].needs === 'artwork' ? c.artworkId : null, opportunityId: c.tool === 'application' ? c.opportunityId : null });
    } catch (e) { c.error = e?.message || 'The Coach is unavailable right now.'; }
    c.busy = false;
    careers.usage = await cloud.coachUsage().catch(() => careers.usage);
    if (currentView() === 'coach') renderView();
  },
  'coach-copy': async () => {
    try { await navigator.clipboard.writeText(careers.coach.result?.text || ''); toast('Copied. Edit it before you use it.', { force: true }); }
    catch { toast('Select the text to copy it.', { force: true }); }
  },
  'coach-for-opportunity': (el) => { Object.assign(careers.coach, { tool: 'application', opportunityId: el.dataset.id, result: null, error: '' }); location.hash = 'coach'; },
  'exhibitions-open': async () => {
    if (!me) return openSignIn();
    careers.exhibitions = await cloud.myExhibitions().catch(() => []);
    openSheet(() => lazyView('careers')?.exhibitionsSheet(careers.exhibitions) ?? LoadingSkeleton({ cards: 3, variant: 'list' }));
  },
  'exhibition-submit': async (el) => {
    const v = (k) => ($(`#ex-${k}`)?.value || '').trim();
    const fail = (msg) => { const e = $('#ex-error'); e.textContent = msg; e.hidden = false; };
    if (v('title').length < 3 || v('venue').length < 2) return fail('Add the exhibition’s title and venue.');
    if (!v('start')) return fail('Add the opening date.');
    if (!/^https:\/\//.test(v('link'))) return fail('Add a link that starts with https:// so a moderator can check it.');
    el.disabled = true;
    try {
      await cloud.submitExhibition({ kind: v('kind'), title: v('title'), venue: v('venue'), city: v('city'), country: state.user.country, start: v('start'), end: v('end'), link: v('link') });
      careers.exhibitions = await cloud.myExhibitions();
      toast('Sent for verification.', { force: true });
      openSheet(() => lazyView('careers')?.exhibitionsSheet(careers.exhibitions) ?? LoadingSkeleton({ cards: 3, variant: 'list' }));
    } catch (e) { el.disabled = false; fail(e?.message || 'Could not send it.'); }
  },
  'exhibition-delete': async (el) => {
    if (!confirm('Remove this exhibition from your Passport?')) return;
    try { await cloud.deleteExhibition(el.dataset.id); careers.exhibitions = await cloud.myExhibitions(); careers.passports.clear(); openSheet(() => lazyView('careers')?.exhibitionsSheet(careers.exhibitions) ?? LoadingSkeleton({ cards: 3, variant: 'list' })); }
    catch (e) { toast(e?.message || 'Could not remove it.', { force: true }); }
  },
  'exhibition-review': async (el) => {
    const verify = el.dataset.v === 'verify';
    const note = verify ? null : prompt('Why couldn’t it be verified? The artist will see this.') || null;
    try { await cloud.reviewExhibition(el.dataset.id, verify, note); toast(verify ? 'Verified.' : 'Marked as not verified.', { force: true }); careers.passports.clear(); await loadAdmin(); }
    catch (e) { toast(e?.message || 'Could not update.', { force: true }); }
  },
  'opportunity-kind': (el) => { careers.oppKind = el.dataset.v; renderView(); },
  'opportunity-save': async (el) => {
    if (!me) return openSignIn();
    try { await cloud.saveOpportunity(el.dataset.id, el.dataset.v === 'on'); toast(el.dataset.v === 'on' ? 'Saved. We’ll remind you 3 days before the deadline.' : 'Removed.', { force: true }); await loadOpportunities(true); }
    catch (e) { toast(e?.message || 'Could not save.', { force: true }); }
  },
  'opportunity-suggest': () => (me ? openSheet(() => lazyView('careers')?.opportunityForm({ admin: isAdmin }) ?? LoadingSkeleton({ cards: 3, variant: 'list' })) : openSignIn()),
  'opportunity-submit': async (el) => {
    const v = (k) => ($(`#op-${k}`)?.value || '').trim();
    const fail = (msg) => { const e = $('#op-error'); e.textContent = msg; e.hidden = false; };
    if (v('title').length < 3 || v('organizer').length < 2 || v('location').length < 2) return fail('Add the title, organizer and location.');
    if (!/^https:\/\//.test(v('link'))) return fail('Add the official link (https://).');
    el.disabled = true;
    try {
      await cloud.suggestOpportunity({ kind: v('kind'), title: v('title'), organizer: v('organizer'), location: v('location'), deadline: v('deadline'),
        eligibility: v('eligibility'), description: v('description'), fee: Number(v('fee')) || 0, currency: (v('currency') || 'USD').toUpperCase(), link: v('link') });
      closeSheet();
      const direct = isAdmin || (member.gallery?.status === 'verified' && member.mine?.plan?.direct_opportunities);
      toast(direct ? 'Published.' : 'Thanks. A moderator will check it.', { force: true });
      await loadOpportunities(true);
      if (currentView() === 'admin') await loadAdmin();
    } catch (e) { el.disabled = false; fail(e?.message || 'Could not send it.'); }
  },
  'opportunity-review': async (el) => {
    try { await cloud.reviewOpportunity(el.dataset.id, el.dataset.v === 'approve', null); toast('Done.', { force: true }); await loadAdmin(); loadOpportunities(true); }
    catch (e) { toast(e?.message || 'Could not update.', { force: true }); }
  },
  // ——— Phase 8 ———
  'index-copy': async () => {
    const t = $('#index-embed');
    try { await navigator.clipboard.writeText(t.value); toast('Copied. Paste it into your website.'); } catch { t.select(); toast('Select and copy the code.'); }
  },
  'index-publish': async () => {
    try { await cloud.publishIndex(); idx.cache.clear(); toast('This week’s Index is published.', { force: true }); }
    catch (e) { toast(e?.message || 'Could not publish it.', { force: true }); }
  },
  'toggle-founding': async (el) => {
    const on = el.dataset.v === '1';
    el.disabled = true;
    try {
      await cloud.setFounding(el.dataset.id, on);
      await loadFounding(true);
      toast(on ? 'Added to Founding artists.' : 'Removed from Founding artists.', { force: true });
    } catch (e) { toast(e?.message || 'Could not change that. Try again.', { force: true }); }
    renderView();
  },
  'tour-open': () => { tourStep = 0; openSheet(() => tourSheet(tourStep)); },
  'tour-next': (el) => { tourStep = Number(el.dataset.v) || 0; refreshSheet(); },
  'tour-done': () => { markWelcomed(); closeSheet(); location.hash = 'discover'; },
  'welcome-dismiss': () => { markWelcomed(); renderView(); },
  'join-artist': () => { location.hash = 'profile'; setTimeout(() => $('[data-act=set-role][data-v=artist]')?.click(), 300); },
  'share-card': async (el) => {
    const w = world.artworkById[el.dataset.id];
    try {
      const blob = await shareCard(w);
      const file = new File([blob], `${w.title.replace(/[^\w-]+/g, '-').slice(0, 40) || 'abremi'}.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: `${w.title} on Abremi` }); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Share card saved. Post it with a link to your Abremi page.', { force: true });
    } catch { toast('Could not make the card. Try again in a moment.', { force: true }); }
  },
  'checkout-buy': async (el) => {
    if (!me) return openSignIn();
    el.disabled = true;
    try { const { url } = await cloud.checkout('buy', { artworkId: el.dataset.id }); location.assign(url); }
    catch (e) { el.disabled = false; toast(e?.message || 'Could not start checkout.', { force: true }); }
  },
  'payouts-setup': async (el) => {
    sales.busy = 'payouts'; renderView();
    try { const { url } = await cloud.checkout(el.dataset.v === 'dashboard' ? 'dashboard' : 'onboard', { country: $('#payout-country')?.value }); location.assign(url); sales.payout = null; sales.orders = null; }
    catch (e) { toast(e?.message || 'Could not open payouts.', { force: true }); }
    sales.busy = ''; renderView();
  },
  'order-ship': async (el) => {
    const id = el.dataset.id;
    try { await cloud.markShipped(id, $(`#ship-carrier-${CSS.escape(id)}`)?.value || '', $(`#ship-tracking-${CSS.escape(id)}`)?.value || ''); sales.orders = null; toast('Marked as shipped. The buyer has been told.', { force: true }); renderView(); }
    catch (e) { toast(e?.message || 'Could not update it.', { force: true }); }
  },
  'order-delivered': async (el) => {
    try { await cloud.confirmDelivery(el.dataset.id); sales.orders = null; toast('Thanks. Enjoy your work.', { force: true }); renderView(); }
    catch (e) { toast(e?.message || 'Could not update it.', { force: true }); }
  },
  'order-dispute': async (el) => {
    const reason = prompt('What went wrong? A moderator will look at it with you and the artist.');
    if (reason == null) return;
    try { await cloud.openDispute(el.dataset.id, reason); sales.orders = null; toast('Reported. A moderator will be in touch.', { force: true }); renderView(); }
    catch (e) { toast(e?.message || 'Could not report it.', { force: true }); }
  },
  'dispute-resolve': async (el) => {
    const refund = el.dataset.v === 'refund';
    if (refund && !confirm('Approve a refund? Then refund the payment in the Stripe dashboard; Abremi records it automatically.')) return;
    try { await cloud.resolveDispute(el.dataset.id, refund, $(`#dispute-note-${CSS.escape(el.dataset.id)}`)?.value || null); toast('Decision recorded and both people told.', { force: true }); await loadAdmin(); }
    catch (e) { toast(e?.message || 'Could not record it.', { force: true }); }
  },
  'offer-open': (el) => {
    if (!me) return openSignIn();
    const w = world.artworkById[el.dataset.id];
    openSheet(() => `<form class="sheet-form" id="offer-form" onsubmit="return false">
      <p class="eyebrow">Make an offer</p><h2 class="display-md" id="modal-title">${esc(w.title)}</h2>
      <p class="muted">${w.availability === 'on_request' ? 'Price on request.' : `Listed at ${esc(money(w.price))}.`} Your offer goes to the artist as a message. Nothing is charged; you agree the details together.</p>
      <div class="field-row"><label class="field"><span>Your offer</span><input id="offer-amount" type="number" min="1" step="1" inputmode="numeric" value="${w.price > 0 ? Math.round(w.price) : ''}"></label>
        <label class="field"><span>Currency</span><input id="offer-currency" maxlength="3" value="USD" autocapitalize="characters"></label></div>
      <label class="field"><span>Message</span><textarea id="offer-message" rows="3" maxlength="2000">Hello, I love “${esc(w.title)}” and would like to make an offer.</textarea></label>
      <p class="form-error" id="offer-error" role="alert" hidden></p>
      <div class="detail-actions">${PremiumButton('Send offer', { act: 'offer-send', attrs: `data-id="${esc(w.id)}"` })}</div></form>`);
  },
  'offer-send': async (el) => {
    const fail = (m) => { const e = $('#offer-error'); e.textContent = m; e.hidden = false; };
    const amount = Number($('#offer-amount')?.value);
    const currency = ($('#offer-currency')?.value || '').trim().toUpperCase();
    const message = ($('#offer-message')?.value || '').trim();
    if (!(amount > 0)) return fail('Enter your offer.');
    if (!/^[A-Z]{3}$/.test(currency)) return fail('Use a three-letter currency code, like USD.');
    if (message.length < 10) return fail('Write a little more (at least 10 characters).');
    el.disabled = true;
    try {
      const id = await cloud.sendOffer(el.dataset.id, amount, currency, message);
      closeSheet();
      toast('Offer sent. The artist will reply in your Inbox.', { force: true });
      loadInbox();
      location.hash = `inquiry/${id}`;
    } catch (e) { el.disabled = false; fail(e?.message || 'Could not send it.'); }
  },
  'watch-toggle': async (el) => {
    if (!me) return openSignIn();
    const id = el.dataset.id;
    const on = !loop.watches.has(id);
    try {
      await cloud.watchArtwork(id, on);
      if (on) loop.watches.add(id); else loop.watches.delete(id);
      toast(on ? 'You’ll be told if it becomes available.' : 'Removed from your waitlist.', { force: true });
      refresh();
    } catch (e) { toast(e?.message || 'Could not change it.', { force: true }); }
  },
  'interests-open': () => (me ? openSheet(interestsSheet) : openSignIn()),
  'interest-toggle': (el) => { const on = el.getAttribute('aria-pressed') !== 'true'; el.setAttribute('aria-pressed', String(on)); el.classList.toggle('is-on', on); },
  'interests-save': async (el) => {
    const picked = $$('#interests-form [data-act=interest-toggle][aria-pressed=true]').map((b) => b.dataset.v);
    const mediums = picked.filter((v) => /^[a-z]+$/.test(v));
    const regions = picked.filter((v) => /^[A-Z]{2}$/.test(v));
    const priceMax = Number($('#interest-price')?.value) || null;
    el.disabled = true;
    try {
      await cloud.setInterests({ mediums, regions, priceMax });
      loop.interests = { mediums, regions, price_max: priceMax };
      deck = [];
      closeSheet();
      toast('Saved. Discover will lean toward these, with some surprises.', { force: true });
      renderView();
    } catch (e) { el.disabled = false; toast(e?.message || 'Could not save that.', { force: true }); }
  },
  // ——— Phase 7: the Guide ———
  'guide-open': () => openGuide(),
  'guide-close': () => closeGuide(),
  'guide-mode': (el) => {
    if (guide.busy) return;
    Object.assign(guide, { mode: el.dataset.v, view: 'chat', error: null });
    renderGuide();
  },
  'guide-settings': () => {
    guide.view = guide.view === 'settings' ? 'chat' : 'settings';
    if (guide.view === 'settings' && !guide.prefs && cloud?.guidePrefs) cloud.guidePrefs().then((p) => { guide.prefs = p; renderGuide(); }).catch(() => {});
    renderGuide();
  },
  'guide-prompt': (el) => guideSend(el.dataset.v),
  'guide-send': () => guideSend($('#guide-input')?.value),
  'guide-retry': () => { if (!guide.busy && guide.threads[guide.mode].at(-1)?.role === 'user') guideAsk(); },
  'guide-new': () => { if (guide.busy) return; guide.threads[guide.mode] = []; guide.error = null; renderGuide(); $('#guide-input')?.focus(); },
  'guide-prefs-save': async () => {
    const personalize = Boolean($('#guide-personalize')?.checked);
    const interests = ($('#guide-interests')?.value || '').trim();
    guide.prefsBusy = true; renderGuide();
    try {
      await cloud.setGuidePrefs(personalize, interests);
      Object.assign(guide, { prefs: { personalize, interests }, view: 'chat' });
      toast('Saved. Your next suggestions will use this.', { force: true });
    } catch (e) { toast(e?.message || 'Could not save that.', { force: true }); }
    guide.prefsBusy = false; renderGuide();
  },
  'guide-reset': async () => {
    if (!confirm('Reset personalization? This clears what you told the Guide you enjoy and what you did with its suggestions. Your follows, admirations and collections stay.')) return;
    try {
      await cloud.resetGuide();
      guide.prefs = { personalize: true, interests: '' };
      guide.threads = { visitor: [], artist: [], collector: [] };
      guide.view = 'chat';
      toast('Personalization reset.', { force: true });
      renderGuide();
    } catch (e) { toast(e?.message || 'Could not reset it.', { force: true }); }
  },
  'guide-search': (el) => {
    const term = el.dataset.v;
    if (window.matchMedia('(max-width: 760px)').matches) closeGuide();
    openSearch();
    const i = $('#search-input');
    if (i) { i.value = term; i.dispatchEvent(new Event('input')); }
  },
  // ——— Phase 6 ———
  'plan-checkout': async (el) => {
    member.busy = el.dataset.v; renderView();
    try { const { url } = await cloud.billing('checkout', el.dataset.v); location.assign(url); }
    catch (e) { toast(e?.message || 'Payments are unavailable right now.', { force: true }); }
    member.busy = ''; renderView();
  },
  'plan-manage': async () => {
    member.busy = 'manage'; renderView();
    try { const { url } = await cloud.billing('portal'); location.assign(url); }
    catch (e) { toast(e?.message || 'Could not open your billing page.', { force: true }); }
    member.busy = ''; renderView();
  },
  'plan-badge': async (el) => {
    const show = el.getAttribute('aria-pressed') !== 'true';
    try {
      await cloud.setPlanBadge(show);
      member.mine = { ...member.mine, show_badge: show };
      member.badges = await cloud.planBadges().catch(() => member.badges);
      toast(show ? 'Your badge is shown on your artist page.' : 'Your badge is hidden.', { force: true });
      renderView();
    } catch (e) { toast(e?.message || 'Could not change it.', { force: true }); }
  },
  'gallery-open': () => (me ? openSheet(() => galleryForm(member.gallery)) : openSignIn()),
  'gallery-submit': async (el) => {
    const v = (k) => ($(`#gal-${k}`)?.value || '').trim();
    const fail = (msg) => { const e = $('#gal-error'); e.textContent = msg; e.hidden = false; };
    if (v('name').length < 2 || v('city').length < 2) return fail('Add the gallery’s name and city.');
    if (!/^[A-Za-z]{2}$/.test(v('country'))) return fail('Use the two-letter country code, e.g. PT or US.');
    if (!/^https:\/\/\S+$/.test(v('website'))) return fail('Add the gallery’s website (https://).');
    el.disabled = true;
    try {
      const before = member.gallery?.status;
      await cloud.applyGallery({ name: v('name'), city: v('city'), country: v('country').toUpperCase(), website: v('website'), bio: v('bio') });
      member.gallery = await cloud.myGallery();
      closeSheet();
      toast(member.gallery?.status === 'verified' ? 'Saved.' : before === 'verified' ? 'Saved. The new name goes to a moderator for review.' : 'Sent. A moderator will check it.', { force: true });
      renderView();
    } catch (e) { el.disabled = false; fail(/after 3 days/.test(e?.message || '') ? e.message : /check constraint/.test(e?.message || '') ? 'Check the details: the website must start with https://.' : e?.message || 'Could not send it.'); }
  },
  'gallery-review': async (el) => {
    try {
      await cloud.reviewGallery(el.dataset.id, el.dataset.v === 'verify', $(`#gal-note-${CSS.escape(el.dataset.id)}`)?.value || null);
      toast(el.dataset.v === 'verify' ? 'Gallery verified.' : 'Declined.', { force: true });
      await loadAdmin();
    } catch (e) { toast(e?.message || 'Could not update.', { force: true }); }
  },
  'plan-search': async () => {
    const query = ($('#plan-search')?.value || '').trim();
    if (query.length < 2) return toast('Type at least 2 letters.');
    try { member.planSearch = { query, results: await cloud.findMembers(query) }; renderView(); }
    catch (e) { toast(e?.message || 'Search failed.', { force: true }); }
  },
  'plan-grant': async (el) => {
    const id = el.dataset.id;
    const plan = $(`#grant-plan-${CSS.escape(id)}`)?.value;
    const until = $(`#grant-until-${CSS.escape(id)}`)?.value;
    el.disabled = true;
    try {
      await cloud.grantPlan(id, plan, until, $(`#grant-note-${CSS.escape(id)}`)?.value || null);
      toast('Plan granted. The member has been told.', { force: true });
      member.planSearch = { query: '', results: null };
      await loadAdmin();
    } catch (e) { el.disabled = false; toast(e?.message || 'Could not grant it.', { force: true }); }
  },
  'plan-revoke': async (el) => {
    if (!confirm(`Remove ${el.dataset.name}’s granted plan? They go back to Artist Free now.`)) return;
    try { await cloud.revokePlan(el.dataset.id, null); toast('Plan removed.', { force: true }); await loadAdmin(); }
    catch (e) { toast(e?.message || 'Could not remove it.', { force: true }); }
  },
  'invite-required': async (el) => {
    const on = el.dataset.v === 'on';
    if (on && !confirm('Require an invite code for new sign-ups? Existing members are not affected.')) return;
    try { await cloud.setInviteRequired(on); member.flags = await cloud.appFlags(); toast(on ? 'New sign-ups now need an invite code.' : 'Sign-ups are open.', { force: true }); await loadAdmin(); }
    catch (e) { toast(e?.message || 'Could not change it.', { force: true }); }
  },
  'invite-create': async () => {
    const uses = Number($('#invite-uses')?.value) || 0;
    const days = Number($('#invite-days')?.value) || 0;
    if (uses < 1 || uses > 500 || days < 1 || days > 365) return toast('Uses 1–500, valid for 1–365 days.');
    try {
      const code = await cloud.createInvite(uses, days, $('#invite-note')?.value || null);
      await loadAdmin();
      toast(`Invite code ${code} created.`, { force: true, duration: 5000 });
    } catch (e) { toast(e?.message || 'Could not create it.', { force: true }); }
  },
  'invite-copy': async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.v); toast('Copied.'); } catch { toast(el.dataset.v, { duration: 6000 }); }
  },
  'invite-revoke': async (el) => {
    if (!confirm(`Revoke ${el.dataset.v}? It stops working right away.`)) return;
    try { await cloud.revokeInvite(el.dataset.v); toast('Revoked.', { force: true }); await loadAdmin(); }
    catch (e) { toast(e?.message || 'Could not revoke it.', { force: true }); }
  },
  'feedback-open': () => { closePopovers(); if (!COMMUNITY) return toast('Feedback needs an account.'); if (!me) return openSignIn(); member.feedbackKind = 'bug'; openSheet(() => feedbackSheet({ kind: member.feedbackKind })); },
  'feedback-kind': (el) => {
    member.feedbackKind = el.dataset.v;
    $$('#feedback-form [data-act=feedback-kind]').forEach((b) => { const on = b === el; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
  },
  'feedback-submit': async (el) => {
    const message = ($('#feedback-message')?.value || '').trim();
    if (message.length < 5) return toast('Tell us a little more (5 characters or more).');
    el.disabled = true;
    try {
      await cloud.submitFeedback(member.feedbackKind, message, `#${location.hash.slice(1).split('?')[0]}`);
      closeSheet();
      toast('Thank you. The Abremi team will read it.', { force: true });
    } catch (e) { el.disabled = false; toast(e?.message || 'Could not send it.', { force: true }); }
  },
  'feedback-resolve': async (el) => {
    try { await cloud.resolveFeedback(el.dataset.id, null); toast('Resolved.', { force: true }); await loadAdmin(); }
    catch (e) { toast(e?.message || 'Could not update.', { force: true }); }
  },
  'admin-jump': (el) => { document.getElementById(el.dataset.v)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  'inquiry-kind': (el) => {
    $$('#inquiry-form [data-act=inquiry-kind]').forEach((b) => { const on = b === el; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
    $('#inquiry-kind').value = el.dataset.v;
  },
  'send-inquiry': async (el) => {
    const f = radar.inquiryFor;
    const message = ($('#inquiry-message')?.value || '').trim();
    const fail = (msg) => { const e = $('#inquiry-error'); e.textContent = msg; e.hidden = false; };
    if (message.length < 10) return fail('Write a little more (at least 10 characters).');
    el.disabled = true;
    try {
      const id = await cloud.sendInquiry({ artworkId: f.artworkId, artistId: f.artworkId ? null : f.artistId, kind: $('#inquiry-kind').value, message });
      closeSheet();
      toast('Sent. The artist has been notified.', { force: true });
      loadInbox();
      location.hash = `inquiry/${id}`;
    } catch (e) { el.disabled = false; fail(e?.message || 'Could not send. Try again.'); }
  },
  'inbox-tab': (el) => { radar.tab = el.dataset.v; renderView(); },
  'send-reply': async (el) => {
    const id = $('#reply-form')?.dataset.id;
    const body = ($('#reply-body')?.value || '').trim();
    if (!body) return;
    el.disabled = true;
    try { await cloud.replyInquiry(id, body); threads.delete(id); renderView(); loadInbox(); }
    catch (e) { el.disabled = false; toast(e?.message || 'Could not send.', { force: true }); }
  },
  'inquiry-status': async (el) => {
    if (!confirm(el.dataset.v === 'declined' ? 'Decline this inquiry? They’ll see that you declined.' : 'Close this conversation?')) return;
    try { await cloud.setInquiryStatus(el.dataset.id, el.dataset.v); threads.delete(el.dataset.id); renderView(); loadInbox(); }
    catch (e) { toast(e?.message || 'Could not update.', { force: true }); }
  },
  'inquiry-block': async (el) => {
    const on = el.dataset.v === 'on';
    if (on && !confirm('Block this member? Your open conversations with them are closed and they can’t contact you.')) return;
    try { await cloud.setBlock(el.dataset.id, on); toast(on ? 'Blocked.' : 'Unblocked.', { force: true }); threads.delete(el.dataset.id); renderView(); loadInbox(); }
    catch (e) { toast(e?.message || 'Could not update.', { force: true }); }
  },
  'inquiry-report': async (el) => {
    const reason = prompt('What’s wrong? A moderator will read this conversation.');
    if (!reason || reason.trim().length < 3) return;
    try { await cloud.reportInquiry(el.dataset.id, reason.trim()); toast('Reported. A moderator will review it.', { force: true }); }
    catch (e) { toast(e?.message || 'Could not report.', { force: true }); }
  },
  'report-resolve': async (el) => {
    try { await cloud.resolveInquiryReport(el.dataset.id, el.dataset.v === 'close', null); toast('Done.', { force: true }); await loadAdmin(); }
    catch (e) { toast(e?.message || 'Could not update.', { force: true }); }
  },
  'open-drop-form': () => {
    if (!me) return openSignIn();
    const works = (world.worksByArtist[myArtistId()] || []).filter((w) => w.member);
    openSheet(() => createDropForm(works.map((w) => ({ id: w.id, title: w.title }))));
  },
  'create-drop': async (el) => {
    const v = (k) => ($(`#drop-${k}`)?.value || '').trim();
    const ids = $$('#drop-form input[name=drop-work]:checked').map((x) => x.value);
    const fail = (msg) => { const e = $('#drop-error'); e.textContent = msg; e.hidden = false; };
    if (v('title').length < 3) return fail('Give the drop a title.');
    if (!ids.length) return fail('Choose at least one work.');
    if (!v('release')) return fail('Choose a release time.');
    el.disabled = true;
    try {
      const palette = await teaserPalette(world.artworkById[ids[0]]?.image).catch(() => null);
      const id = await cloud.createDrop({ title: v('title'), description: v('description'), releaseAt: new Date(v('release')).toISOString(), artworkIds: ids, palette });
      closeSheet();
      toast('Drop scheduled. Your followers have been notified.', { force: true });
      await refreshCommunity();
      loadDrops(true);
      location.hash = `drop/${id}`;
    } catch (e) { el.disabled = false; fail(e?.message || 'Could not schedule the drop.'); }
  },
  'drop-subscribe': async (el) => {
    try { await cloud.subscribeDrop(el.dataset.id, el.dataset.v === 'on'); dropDetails.delete(el.dataset.id); toast(el.dataset.v === 'on' ? 'We’ll notify you at the release.' : 'Notification removed.', { force: true }); renderView(); }
    catch (e) { toast(e?.message || 'Could not update.', { force: true }); }
  },
  'drop-cancel': async (el) => {
    if (!confirm('Cancel this drop? Its works become visible now, without a release announcement.')) return;
    try { await cloud.cancelDrop(el.dataset.id, null); dropDetails.delete(el.dataset.id); await refreshCommunity(); loadDrops(true); toast('Drop cancelled.', { force: true }); renderView(); }
    catch (e) { toast(e?.message || 'Could not cancel.', { force: true }); }
  },
  'studio-days': (el) => { studio.days = Number(el.dataset.v) || 30; studio.data = undefined; renderView(); },
  'open-link': (el) => { closePopovers(); if (el.dataset.id) location.hash = el.dataset.id; },
  'arena-tab': (el) => {
    arena.tab = el.dataset.v;
    if (arena.tab !== 'battles') loadArena(true);
    if (currentView() === 'battle') renderView(); else location.hash = 'battle';
  },
  'enter-competition': (el) => {
    const d = arena.details.get(el.dataset.v)?.data;
    if (!d) return;
    openSheet(() => enterSheet(d, eligibleWorks(d).map((w) => ({ id: w.id, title: w.title, html: `<span class="rank-thumb">${ArtImage(w)}</span>` }))));
  },
  'enter-with': async (el) => {
    el.disabled = true;
    try {
      await cloud.enterCompetition(el.dataset.v, el.dataset.id);
      closeSheet();
      toast('You’re in. Voting opens on schedule.', { force: true });
      loadAchievements();
      refreshCompetition(el.dataset.v);
    } catch (e) { el.disabled = false; toast(e?.message || 'Could not enter.', { force: true }); }
  },
  'withdraw-entry': async (el) => {
    if (!confirm('Withdraw your entry?')) return;
    try { await cloud.withdrawEntry(el.dataset.v); toast('Entry withdrawn.', { force: true }); refreshCompetition(el.dataset.v); }
    catch (e) { toast(e?.message || 'Could not withdraw.', { force: true }); }
  },
  'vote-entry': async (el) => {
    const id = route().param;
    if (!me) return openSignIn();
    el.disabled = true;
    try { await cloud.voteCompetition(id, el.dataset.v); toast('Vote saved. You can change it until voting closes.', { force: true }); refreshCompetition(id); }
    catch (e) { el.disabled = false; toast(e?.message || 'Could not save your vote.', { force: true }); }
  },
  'create-competition': async (el) => {
    const v = (k) => ($(`#comp-${k}`)?.value || '').trim();
    const iso = (k) => (v(k) ? new Date(v(k)).toISOString() : '');
    const fail = (msg) => { const e = $('#comp-error'); e.textContent = msg; e.hidden = false; };
    if (v('title').length < 3) return fail('Give it a title.');
    if (!(iso('open') && iso('voting') && iso('close')) || !(iso('open') < iso('voting') && iso('voting') < iso('close'))) return fail('Entries must open before voting, and voting must open before it closes.');
    el.disabled = true;
    try {
      await cloud.createCompetition({ kind: v('kind'), title: v('title'), brief: v('brief'), rules: v('rules'), category: v('category'), country: v('country'),
        entriesOpenAt: iso('open'), votingOpensAt: iso('voting'), votingClosesAt: iso('close') });
      toast('Competition created.', { force: true });
      await loadArena(true);
      renderView();
    } catch (e) { el.disabled = false; fail(e?.message || 'Could not create the competition.'); }
  },
  'cancel-competition': async (el) => {
    if (!confirm('Cancel this competition? Entrants keep their works; the competition ends without results.')) return;
    try { await cloud.cancelCompetition(el.dataset.v, null); toast('Competition cancelled.', { force: true }); await loadArena(true); renderView(); }
    catch (e) { toast(e?.message || 'Could not cancel.', { force: true }); }
  },
  'share-artwork': async (el) => {
    const w = world.artworkById[el.dataset.id];
    const url = `${location.origin}${location.pathname}#art/${encodeURIComponent(el.dataset.id)}`;
    try {
      if (navigator.share) await navigator.share({ title: `${w?.title || 'Artwork'} on Abremi`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied', { force: true }); }
    } catch { /* share sheet dismissed */ }
  },
  'edit-artwork': (el) => {
    const w = world.artworkById[el.dataset.id];
    if (w && isMine(w)) openSheet(() => artworkEditForm(w));
  },
  'save-artwork': async (el) => {
    const id = $('#artwork-edit-form')?.dataset.id;
    const w = world.artworkById[id];
    if (!w) return;
    const v = (k) => ($(`#edit-${k}`)?.value || '').trim();
    const fields = {
      title: v('title'), category: v('category'), style: v('style'), medium: v('medium'), year: Number(v('year')) || w.year,
      price: Number(v('price')) || w.price, description: v('description'), dimensions: v('dimensions'), availability: v('availability'),
    };
    const fail = (msg) => { const e = $('#edit-error'); e.textContent = msg; e.hidden = false; };
    const problems = validateUpload({ title: fields.title, category: fields.category, style: fields.style, price: fields.price, year: fields.year, fileType: 'image/webp', fileSize: 1 });
    if (problems.length) return fail(problems[0]);
    el.disabled = true;
    try {
      await cloud.updateArtwork(id, fields);
      const edition = Number(v('edition')) || null;
      if (cloud.setEdition && edition !== (w.editionSize || null)) await cloud.setEdition(id, edition);
      await refreshCommunity();
      await loadSales();
      closeSheet();
      toast('Saved.', { force: true });
      renderView();
    } catch (e) {
      el.disabled = false;
      fail(e?.message || 'Could not save. Try again.');
    }
  },
  'edit-artist-profile': () => {
    if (COMMUNITY && !me) return openSignIn();
    portraitChoice = null;
    openSheet(() => artistProfileForm(world.artistById[myArtistId()] || { name: state.user.name }));
  },
  'save-artist-profile': async (el) => {
    const v = (k) => ($(`#profile-${k}`)?.value || '').trim();
    const fields = { bio: v('bio'), statement: v('statement'), website: v('website'), instagram: v('instagram').replace(/^@/, ''), city: v('city') };
    const fail = (msg) => { const e = $('#profile-error'); e.textContent = msg; e.hidden = false; };
    const problem = validateArtistProfile(fields);
    if (problem) return fail(problem);
    const current = world.artistById[myArtistId()];
    el.disabled = true;
    try {
      let avatarPath = $('#portrait-remove')?.checked ? null : current?.avatarPath || null;
      if (portraitChoice) {
        const prepared = await prepareImage(portraitChoice);
        avatarPath = await cloud.uploadPortrait(prepared.thumb);
      }
      await cloud.updateArtistProfile({ ...fields, avatarPath });
      await refreshCommunity();
      closeSheet();
      toast('Your artist profile is updated.', { force: true });
      renderView();
    } catch (e) {
      el.disabled = false;
      fail(e?.message || 'Could not save your profile. Try again.');
    }
  },
  'share-artist': async (el) => {
    const a = world.artistById[el.dataset.id];
    const url = `${location.origin}${location.pathname}#artist/${encodeURIComponent(el.dataset.id)}`;
    try {
      if (navigator.share) await navigator.share({ title: `${a.name} on Abremi`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied', { force: true }); }
    } catch { /* share sheet dismissed */ }
  },
  'discover-cat': (el) => { discover.category = el.dataset.v; deck = []; renderView(); },
  'apply-role': (el) => sendApplication(el.dataset.v),
  'goto-profile': () => { closePopovers(); location.hash = 'profile'; },
  'withdraw-application': async (el) => {
    if (!confirm('Withdraw your application?')) return;
    try {
      await cloud.withdrawApplication(el.dataset.id);
      state.applications = await cloud.myApplications();
      commit();
      closeSheet();
      toast('Application withdrawn', { force: true });
      renderView();
    } catch (e) { toast(e?.message || 'Could not withdraw it.', { force: true }); }
  },
  'admin-reload': () => { adminData = null; renderView(); },
  'admin-decide': async (el) => {
    const approve = el.dataset.v === 'approve';
    const note = ($(`#note-${el.dataset.id}`)?.value || '').trim().slice(0, 500);
    if (!approve && !note && !confirm('Decline without a note? A short reason helps the applicant.')) return;
    el.disabled = true;
    try {
      await cloud.decideApplication(el.dataset.id, approve, note);
      toast(approve ? 'Approved: their new role is active' : 'Declined', { force: true });
      memberCache.clear();
      await loadAdmin();
    } catch (e) { el.disabled = false; toast(e?.message || 'Could not save the decision.', { force: true }); }
  },
  'admin-revoke': async (el) => {
    if (!confirm(`Remove ${el.dataset.name}'s verified role? Their past votes keep the weight they had.`)) return;
    try {
      await cloud.revokeRole(el.dataset.id, null);
      toast('Role removed', { force: true });
      memberCache.clear();
      await loadAdmin();
    } catch (e) { toast(e?.message || 'Could not remove the role.', { force: true }); }
  },
  'flag-resolve': async (el) => {
    const exclude = el.dataset.v === 'exclude';
    if (exclude && !confirm('Exclude these admirations from the rankings? They are kept, and the decision is recorded.')) return;
    try {
      const n = await cloud.resolveFlag(el.dataset.id, exclude, $(`#flag-note-${el.dataset.id}`)?.value || null);
      toast(exclude ? `${n} like${n === 1 ? '' : 's'} excluded from the rankings.` : 'Flag dismissed.', { force: true });
      await loadAdmin();
      refreshCommunity().then(() => renderView()).catch(() => {});
    } catch (e) { toast(e?.message || 'Could not update the flag.', { force: true }); }
  },
  'members-scope': (el) => { charts.memberCountry = el.dataset.v; renderView(); },
  'members-retry': () => { memberCache.delete(memberKey()); renderView(); },
  'members-season': (el) => { charts.memberSeason = el.dataset.v; renderView(); },
  'chart-expand': (el) => { charts.expanded = charts.expanded === el.dataset.v ? '' : el.dataset.v; renderView(); },
  'chart-country': (el) => { Object.assign(charts, { tab: 'countries', country: el.dataset.v, expanded: '' }); renderView(); window.scrollTo(0, 0); },
  'charts-goto': (el) => { Object.assign(charts, { tab: el.dataset.v, country: '', expanded: '' }); location.hash = 'charts'; },
  'add-to-collection': (el) => openSheet(() => addToCollectionSheet(el.dataset.id)),
  'new-collection': (el) => { newCollectionFor = el.dataset.id || null; openSheet(newCollectionSheet); setTimeout(() => $('#collection-name')?.focus(), 50); },
  'collection-preset': (el) => { const i = $('#collection-name'); i.value = el.dataset.v; i.focus(); },
  'collection-create': async (el) => {
    const name = ($('#collection-name')?.value || '').trim().slice(0, 60);
    if (!name) return toast('Give the collection a name.', { force: true });
    const c = { id: `c${Date.now().toString(36)}`, name, private: $('#collection-private')?.checked !== false, ids: newCollectionFor ? [newCollectionFor] : [], at: Date.now() };
    if (syncedCollections()) {
      el.disabled = true;
      try {
        const row = await cloud.createCollection({ name, isPrivate: c.private });
        Object.assign(c, { id: row.id, server: true });
        if (newCollectionFor) await cloud.addToCollection(row.id, newCollectionFor);
        if (newCollectionFor && guide.pendingAdd === newCollectionFor) { guideEvent('collection_add', newCollectionFor); guide.pendingAdd = null; }
      } catch (e) {
        el.disabled = false;
        return toast(e?.message || 'Could not create the collection.', { force: true });
      }
    }
    state.collections.push(c);
    saveState(state);
    toast(`Created “${name}”${newCollectionFor ? ' with this work' : ''}`, { force: true });
    const back = newCollectionFor;
    newCollectionFor = null;
    checkAchievements();
    if (back) openSheet(() => addToCollectionSheet(back)); else closeSheet();
    renderView();
  },
  'collection-toggle': (el) => {
    const c = state.collections.find((x) => x.id === el.dataset.v);
    if (!c) return;
    const id = el.dataset.id;
    const adding = !c.ids.includes(id);
    if (adding && guide.pendingAdd === id) { guideEvent('collection_add', id); guide.pendingAdd = null; }
    c.ids = adding ? [id, ...c.ids] : c.ids.filter((x) => x !== id);
    saveState(state);
    if (c.server) remote(() => (adding ? cloud.addToCollection(c.id, id) : cloud.removeFromCollection(c.id, id)));
    checkAchievements();
    refresh();
  },
  'open-user-collection': (el) => openSheet(() => userCollectionSheet(el.dataset.v), { wide: true }),
  'collection-private': (el) => {
    const c = state.collections.find((x) => x.id === el.dataset.v);
    if (!c) return;
    c.private = !c.private;
    saveState(state);
    if (c.server) remote(() => cloud.updateCollection(c.id, { isPrivate: c.private }));
    if (c.server && !c.private) toast('Shared: anyone with the link can see this collection.', { force: true });
    refresh();
  },
  'share-collection': async (el) => {
    const c = state.collections.find((x) => x.id === el.dataset.v) || sharedCollections.get(el.dataset.v)?.data;
    const url = `${location.origin}${location.pathname}#collection/${encodeURIComponent(el.dataset.v)}`;
    try {
      if (navigator.share) await navigator.share({ title: `${c?.name || 'A collection'} on Abremi`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied', { force: true }); }
    } catch { /* share sheet dismissed */ }
  },
  'edit-collection': (el) => {
    const c = state.collections.find((x) => x.id === el.dataset.v);
    if (c) openSheet(() => collectionEditForm(c));
  },
  'save-collection': (el) => {
    const c = state.collections.find((x) => x.id === el.dataset.v);
    const name = ($('#collection-edit-name')?.value || '').trim();
    if (!c) return;
    if (!name) return toast('Give the collection a name.', { force: true });
    c.name = name.slice(0, 60);
    c.description = ($('#collection-edit-description')?.value || '').trim().slice(0, 500);
    saveState(state);
    if (c.server) remote(() => cloud.updateCollection(c.id, { name: c.name, description: c.description }));
    sharedCollections.delete(c.id);
    closeSheet();
    renderView();
  },
  'collection-delete': (el) => {
    const c = state.collections.find((x) => x.id === el.dataset.v);
    if (!c || !confirm(`Delete the collection “${c.name}”? The works stay on Abremi.`)) return;
    state.collections = state.collections.filter((x) => x !== c);
    saveState(state);
    if (c.server) remote(() => cloud.deleteCollection(c.id));
    closeSheet();
    renderView();
  },
  buy: (el) => {
    const w = world.artworkById[el.dataset.id];
    if (!w) return;
    if (w.sample) return toast('Sample works aren’t for sale.');
    if (COMMUNITY) return openInquiry({ artworkId: w.id }); // no simulated purchases with real accounts
    openSheet(() => buySheet(w.id));
  },
  contact: (el) => (world.artistById[el.dataset.id]?.sample ? toast('Sample artists can’t be contacted.')
    : COMMUNITY ? openInquiry({ artistId: el.dataset.id, kind: 'commission' }) : openSheet(() => contactSheet(el.dataset.id))),
  review: (el) => {
    const id = el.dataset.id;
    if (state.reviews.some((r) => r.artworkId === id)) return toast('You have already reviewed this work.');
    openSheet(() => reviewSheet(id));
  },
  star: (el) => {
    const n = Number(el.dataset.n);
    $('#stars').dataset.rating = n;
    $$('#stars button').forEach((b, i) => { b.classList.toggle('is-on', i < n); b.setAttribute('aria-checked', String(i + 1 === n)); });
  },
  'submit-review': (el) => {
    const id = el.dataset.id;
    const rating = Number($('#stars').dataset.rating || 0);
    if (!rating) return toast('Choose a star rating first.');
    const text = $('#review-text').value.trim().slice(0, 500);
    state.reviews.push({ artworkId: id, rating, text, at: Date.now() });
    const d = ensureDelta(id);
    d.reviews.count++;
    d.reviews.ratingSum += rating;
    state.taste = updateTaste(state.taste, world.artworkById[id], 'review');
    commit();
    remote(() => cloud.addReview(id, rating, text), 'Your review was not published. Try again.');
    toast(`Review published · +${ROLE_WEIGHTS.critic * 2 * (rating / 5)} influence`);
    openSheet(() => artworkSheet(id), { wide: true });
    renderView();
  },
  follow: (el) => {
    const id = el.dataset.id;
    const tally = COMMUNITY && me ? (state.community.followerDeltas[id] ||= emptyRoleCounts()) : null;
    if (state.follows[id]) {
      if (tally) tally[state.follows[id]] = Math.max(0, (tally[state.follows[id]] || 0) - 1);
      delete state.follows[id];
    } else {
      state.followMeta[id] = { at: Date.now(), followersAt: followersTotal(id) };
      state.follows[id] = state.user.role;
      if (tally) tally[state.user.role]++;
      state.taste = { ...state.taste, artists: { ...state.taste.artists, [id]: (state.taste.artists[id] || 0) + 1.5 } };
      toast(`Following ${world.artistById[id].name}`);
      if (COMMUNITY && !me) setTimeout(() => nudgeSignIn('follows'), 2500);
    }
    commit();
    if (COMMUNITY && me && !world.artistById[id]?.isMe) remote(() => cloud.setFollow(id, Boolean(state.follows[id])));
    refresh();
  },
  sponsor: (el) => {
    if (world.artistById[el.dataset.id]?.sample) return toast('Sample artists can’t be sponsored.');
    if (COMMUNITY) return openInquiry({ artistId: el.dataset.id, kind: 'sponsorship' });
    state.messages.push({ artistId: el.dataset.id, text: '[sponsorship request]', at: Date.now() });
    commit();
    updateNotificationDot();
    toast(`Sponsorship request sent to ${world.artistById[el.dataset.id].name}`);
  },
  'send-message': (el) => {
    const text = $('#msg').value.trim();
    if (!text) return toast('Write a message first.');
    const artistId = el.dataset.artist || world.artworkById[el.dataset.id].artistId;
    state.messages.push({ artistId, artworkId: el.dataset.id || null, text: text.slice(0, 1000), at: Date.now() });
    commit();
    updateNotificationDot();
    toast(`Message sent to ${world.artistById[artistId].name}`);
    closeSheet();
  },
  purchase: (el) => {
    const w = world.artworkById[el.dataset.id];
    const b = checkoutBreakdown(w.price);
    state.purchases.push({ artworkId: w.id, price: b.price, fee: b.fee, at: Date.now() });
    setReaction(w, 'super');
    deck = deck.filter((d) => d.artwork.id !== w.id);
    toast(`“${w.title}” is now in your collection`);
    refresh();
  },
  vote: (el) => vote(Number(el.dataset.i)),
  'chart-tab': (el) => { Object.assign(charts, { tab: el.dataset.v, expanded: '', country: '' }); renderView(); },
  'chart-cat': (el) => { charts.category = el.dataset.v; charts.expanded = ''; renderView(); },
  'home-cat': (el) => { homeFeed.category = el.dataset.v; renderView(); },
  'home-mode': (el) => { homeFeed.mode = el.dataset.v; renderView(); },
  'explore-cat': (el) => { explore.category = el.dataset.v; explore.limit = 24; renderView(); },
  'explore-clear': (el) => { explore[el.dataset.v] = ''; renderView(); },
  'explore-more': () => { explore.limit += 24; renderView(); },
  'artists-cat': (el) => { artistsView.category = el.dataset.v; artistsView.limit = 24; renderView(); },
  'artists-more': () => { artistsView.limit += 24; renderView(); },
  'open-collection': (el) => openSheet(() => collectionSheet(el.dataset.v), { wide: true }),
  'open-style': (el) => { Object.assign(explore, { style: el.dataset.v, country: '', category: '', limit: 24 }); location.hash = 'explore'; },
  'open-country': (el) => { Object.assign(explore, { country: el.dataset.v, style: '', category: '', limit: 24 }); location.hash = 'explore'; },
  'set-role': (el) => {
    const next = el.dataset.v;
    if (next === state.user.role) return;
    if (COMMUNITY) {
      if (!me) return openSignIn();
      if (next === 'critic' || next === 'collector') return openSheet(() => applySheet(next));
      const before = state.user.role;
      state.user.role = next;
      commit();
      renderView();
      pendingWrites++;
      cloud.updateProfile({ role: next })
        .then(() => toast(`You’re now ${/^[AEIOU]/.test(role().label) ? 'an' : 'a'} ${role().label}. Your votes count ×${role().weight}.`))
        .catch((e) => { state.user.role = before; commit(); renderView(); toast(e?.message || 'Could not change your role.'); })
        .finally(() => { pendingWrites--; });
      return;
    }
    state.user.role = next;
    commit();
    toast(`You’re now ${/^[AEIOU]/.test(role().label) ? 'an' : 'a'} ${role().label}. Your votes count ×${role().weight}.`);
    renderView();
  },
  'scan-sample': () => scanSample(),
  about: () => openSheet(aboutSheet),
  'reset-swipes': () => {
    // Passed works come back; liked and saved works stay where they are.
    for (const [id, v] of Object.entries(state.interactions)) if (v === 'pass') delete state.interactions[id];
    deck = [];
    commit();
    renderView();
    if (!deck.length) toast('You have liked or saved every work here. Try another medium.');
  },
  reset: () => {
    if (!confirm(COMMUNITY ? 'Clear the data stored on this device? Your account is not affected.' : 'Reset all demo data on this device?')) return;
    const community = state.community;
    state = resetState();
    if (COMMUNITY) state.community = community || emptyCommunity();
    deck = []; battlePair = null; battleOutcome = null; lastScan = null;
    if (me) return resync().then(renderView);
    commit();
    renderView();
  },
  'sign-in': () => openSignIn(),
  'delete-artwork': (el) => deleteArtwork(el.dataset.id),
  'pwa-install': async () => {
    closePopovers();
    const result = await pwa.install();
    if (result === 'ios') openSheet(iosInstallSheet);
    else if (result === 'unavailable') toast('Use your browser’s menu and choose “Install app” or “Add to Home Screen”.', { duration: 4000 });
  },
  'pwa-update': () => pwa.applyUpdate(),
  'send-link': () => sendLink(),
  'verify-code': () => verifyCode(),
  'auth-back': () => { Object.assign(auth, { stage: 'email', error: '' }); refreshSheet(); },
  'sign-out': () => signOut(),
  'close-sheet': () => closeSheet(),
  'open-search': () => openSearch(),
  'close-search': () => closeSearch(),
  'search-term': (el) => { const i = $('#search-input'); i.value = el.dataset.v; i.dispatchEvent(new Event('input')); i.focus(); },
  'search-open': (el) => {
    closeSearch();
    if (el.dataset.kind === 'artist') openArtist(el.dataset.id);
    else openSheet(() => artworkSheet(el.dataset.id), { wide: true });
  },
  'toggle-notifications': (el) => togglePopover('notifications', el),
  'toggle-menu': (el) => togglePopover('menu', el),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!e.target.closest('.popover-wrap')) closePopovers();
  if (e.target.closest('.popover a')) closePopovers();
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'comp-kind') { arena.adminKind = e.target.value; renderView(); return; }
  if (e.target.id !== 'portrait-file') return;
  const file = e.target.files?.[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) return toast('Choose a photo.', { force: true });
  portraitChoice = file;
  const url = URL.createObjectURL(file);
  $('#portrait-preview').innerHTML = `<span class="avatar avatar-xl has-photo"><img src="${url}" alt=""></span>`;
});
document.addEventListener('input', (e) => {
  const count = e.target.id ? document.getElementById(`${e.target.id}-count`) : null;
  if (count?.dataset.max) count.textContent = `${e.target.value.length} / ${count.dataset.max}`;
  if (e.target.id === 'apply-statement') $('#apply-count').textContent = `${e.target.value.trim().length} / 1500`;
});

// The Guide: count what people do with its suggestions (before the action runs), and grow the text box.
$('#guide')?.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  const card = e.target.closest('[data-guide-ref], .guide-search-row, .guide-text');
  if (!el || !card) return;
  const id = el.dataset.id || el.dataset.v;
  const act = el.dataset.act;
  if (act === 'artwork') guideEvent('artwork_click', id);
  else if (act === 'artist') guideEvent('artist_visit', id);
  else if (act === 'follow' && !state.follows[id]) guideEvent('follow', id);
  else if (act === 'guide-search') guideEvent('search', id);
  else if (act === 'add-to-collection') guide.pendingAdd = id;
}, true);
$('#guide')?.addEventListener('input', (e) => {
  if (e.target.id !== 'guide-input') return;
  guide.input = e.target.value;
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, textarea, select');
  if (e.key === 'Escape') {
    if (!$('#search').hidden) return closeSearch();
    if (sheetRenderer) return closeSheet();
    if (guide.open) return closeGuide();
    return closePopovers();
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.id === 'guide-input') { e.preventDefault(); return guideSend(e.target.value); }
  if (typing) return;
  if (e.key === '/' || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); return openSearch(); }
  if (sheetRenderer || !$('#search').hidden) return;
  const view = currentView();
  if (view === 'discover') {
    if (e.key === 'ArrowRight') decide('like');
    if (e.key === 'ArrowLeft') decide('pass');
    if (e.key === 'ArrowUp') { e.preventDefault(); decide('super'); }
    if (e.key === 'Enter' && deck[0] && !e.target.closest('button, a')) openSheet(() => artworkSheet(deck[0].artwork.id), { wide: true });
  } else if (view === 'battle') {
    if (e.key === 'ArrowLeft') vote(0);
    if (e.key === 'ArrowRight') vote(1);
  }
});

// Keep focus inside an open modal.
document.addEventListener('focusin', (e) => {
  const open = !$('#search').hidden ? $('#search') : sheetRenderer ? $('#sheet') : null;
  if (open && !open.contains(e.target)) $('button, input', open)?.focus({ preventScroll: true });
});

window.addEventListener('scroll', () => $('#nav').classList.toggle('is-scrolled', window.scrollY > 8), { passive: true });
window.addEventListener('hashchange', navigate);
// Daily Masterpiece countdowns tick each second; at midnight the next masterpiece is revealed.
setInterval(() => {
  const els = document.querySelectorAll('[data-countdown]');
  for (const el of els) {
    const left = Number(el.dataset.countdown) - Date.now();
    el.textContent = formatCountdown(left);
    if (left <= 0 && !sheetRenderer) { renderView(); break; }
  }
}, 1000);
pwa = initPWA({
  toast,
  onChange: () => {
    const view = currentView();
    if (!sheetRenderer && (view === 'home' || view === 'profile')) renderView();
    else { const m = $('#menu-install'); if (m) m.hidden = !pwa.status().available; }
  },
});
renderView();
connectCommunity();
