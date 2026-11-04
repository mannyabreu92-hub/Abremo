import { buildSeedWorld, CATEGORIES, STYLES, COUNTRIES, PALETTES, CURRENT_YEAR, categoryById, countryByCode } from '../core/seed.js';
import { ROLES, ROLE_WEIGHTS, SAVE_MULTIPLIER, influenceBreakdown, emptyRoleCounts } from '../core/scoring.js';
import { battleResult, expectedScore, pickBattlePair, kFactor, LOSS_FACTOR, START_RATING } from '../core/elo.js';
import { nextArtwork, updateTaste, topStyles, EXPLOIT_RATIO } from '../core/feed.js';
import { PLANS, checkoutBreakdown, hasFeature } from '../core/marketplace.js';
import { BADGES, BADGE_RULES, userBadges } from '../core/badges.js';
import { rank, rankMap, movement, rollSnapshot, hourKey } from '../core/rankings.js';
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
import { emptyCommunity, snapshotToCommunity, mineToState, guestContributions } from '../core/community.js';
import {
  esc, fmt, money, flag, countryName, initials, Icon, ArtImage, Avatar, PremiumButton, IconButton, AbremiSymbol,
  ArtworkCard, ArtworkGrid, FeaturedArtwork, ArtistCard, CategoryFilter, Select, SearchBar,
  ArtBattleCard, BattleArena, CollectionCard, EmptyState, LoadingSkeleton, SectionHeader, Movement,
} from './components.js';

// ——— State ———
const seed = buildSeedWorld();
let state = loadState();

// Community mode: everyone's likes, follows and votes are shared through Supabase.
// Demo mode (no configuration): everything stays on this device, exactly as before.
const COMMUNITY = Boolean(window.__abremiCloud || (SUPABASE_URL && SUPABASE_ANON_KEY));
let cloud = null; // backend adapter, once connected
let me = null; // signed-in account { id, email }
let pendingWrites = 0;
let pwa = null; // install + offline support, set up after the first render's helpers exist
const auth = { stage: 'email', email: '', busy: false, error: '' };
if (COMMUNITY) state.community ||= emptyCommunity();

/** What the rankings are computed from: this device's actions, or the whole community's. */
function viewState() {
  if (!COMMUNITY) return state;
  const c = state.community;
  return {
    ...state,
    deltas: c.deltas, elo: c.elo, followerDeltas: c.followerDeltas,
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
const charts = { tab: 'global', expanded: '', country: '', category: '', memberCountry: '' };
const explore = { category: '', style: '', country: '', sort: 'trending', limit: 24 };
const artistsView = { country: '', category: '', limit: 24 };
const homeFeed = { category: '', mode: 'trending' };
let sheetRenderer = null;
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
function nudgeSignIn(what = 'likes') {
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
  document.body.classList.remove('modal-open');
  setTimeout(() => { if (!sheetRenderer) sheet.hidden = true; }, 240);
  lastFocus?.focus?.({ preventScroll: true });
}

function refresh() {
  renderView();
  if (sheetRenderer) $('#sheet-body').innerHTML = sheetRenderer();
}

// ——— Router ———
const VIEWS = {
  home: renderHome, discover: renderDiscover, explore: renderExplore, battle: renderBattle, artists: renderArtists,
  collections: renderCollections, charts: renderCharts, scan: renderScan, profile: renderProfile, artist: renderArtistPage,
};
/** #view or #view/param (e.g. #artist/a12). Unknown routes fall back to home. */
function route() {
  const [name, ...rest] = location.hash.slice(1).split('/');
  return VIEWS[name] ? { name, param: decodeURIComponent(rest.join('/')) } : { name: 'home', param: '' };
}
const currentView = () => route().name;
const NAV_SECTION = { artist: 'artists' };

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
  VIEWS[name]($('#view'));
}

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
  if (prev === 'like' || prev === 'super') {
    const d = ensureDelta(id);
    const bucket = prev === 'like' ? d.likes : d.saves;
    bucket[prevRole] = Math.max(0, (bucket[prevRole] || 0) - 1);
  }
  state.interactionRoles ||= {};
  if (next) {
    const r = state.user.role;
    if (next === 'like') ensureDelta(id).likes[r]++;
    if (next === 'super') ensureDelta(id).saves[r]++;
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
  const added = contributionOf(next, state.interactionRoles?.[id]) - pointsBefore;
  if (added && counts()) {
    state.activity.push({ t: Date.now(), id, pts: added });
    if (state.activity.length > 600) state.activity.splice(0, state.activity.length - 600);
  }
  commit();
  if (added > 0 && counts()) influenceFeedback(added, before, standingOf(id), next === 'super');
  checkAchievements();
  if (COMMUNITY) { // every artwork in community mode (catalog or member upload) exists on the server
    if (me) remote(() => cloud.setReaction(id, next || null));
    else if (next === 'like' || next === 'super') nudgeSignIn('likes');
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
  chip.innerHTML = `${superLike ? '★ Super Like · ' : ''}<b>+${points}</b> Influence added${climbed > 0 ? `<span>↑ ${climbed} to No. ${after.rank}</span>` : ''}`;
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

function myAchievements(taste = myTaste()) {
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
  const a = ACHIEVEMENTS[id];
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
  const prev = state.snapshot?.prev?.artist || null;
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
  const pick = dailyMasterpiece(world.topArtworks().filter((r) => !isMine(r.item)), credOf, new Date());
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
        <button class="btn btn-icon${r === 'like' || r === 'super' ? ' is-on' : ''}" data-act="react" data-v="like" data-id="${w.id}" aria-pressed="${r === 'like' || r === 'super'}" aria-label="Like">${Icon('heart', { size: 18 })}</button>
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
  const feedSource = homeFeed.mode === 'new'
    ? catalog().slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.year - a.year || world.influence[b.id] - world.influence[a.id])
    : top.map((r) => r.item);
  const feed = feedSource.filter((w) => !homeFeed.category || w.category === homeFeed.category).slice(0, 8);
  const ins = artistInsights();
  const rising = world.artists.filter((a) => !a.isMe && ins.signals[a.id]?.includes('rising'))
    .sort((a, b) => ins.mom[b.id] - ins.mom[a.id]).slice(0, 4);
  if (!battlePair) newBattle();
  const countries = countryStandings(world.artists, (a) => world.artistScores[a.id], world.artworks, (w) => world.influence[w.id]).slice(0, 5);
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
      ${masterpieceHTML(mp)}

      ${rising.length ? `<section class="section">
        ${SectionHeader({ eyebrow: 'Discover them first', title: 'Rising artists', action: `<a class="link-arrow" href="#artists">All artists ${Icon('arrow', { size: 16 })}</a>` })}
        <div class="artist-grid">${rising.map((a) => ArtistCard(a, { cover: coverOf(a.id), following: !!state.follows[a.id], rank: world.globalArtistRanks[a.id], signals: signalChips(a.id) })).join('')}</div>
      </section>` : ''}

      <section class="section">
        ${SectionHeader({ eyebrow: 'Discover', title: homeFeed.mode === 'new' ? 'New discoveries' : 'Trending now', action: `<div class="seg seg-sm" role="tablist">
          <button role="tab" class="${homeFeed.mode === 'trending' ? 'is-on' : ''}" aria-selected="${homeFeed.mode === 'trending'}" data-act="home-mode" data-v="trending">Trending</button>
          <button role="tab" class="${homeFeed.mode === 'new' ? 'is-on' : ''}" aria-selected="${homeFeed.mode === 'new'}" data-act="home-mode" data-v="new">New</button></div>` })}
        ${CategoryFilter(CATEGORIES, homeFeed.category, { act: 'home-cat', allLabel: 'All', pills: true })}
        ${feed.length ? ArtworkGrid(feed.map((w) => card(w))) : EmptyState({ title: 'Nothing here yet', body: 'Try another medium.' })}
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
  return `<footer class="footer">${AbremiSymbol(18)}<span class="brand-word">Abremi</span><span>Discover art. Shape culture.</span><button class="link" data-act="about">About</button></footer>`;
}

// ——— Discover (swipe) ———
function fillDeck() {
  const seen = new Set([...Object.keys(state.interactions), ...deck.map((d) => d.artwork.id)]);
  const pool = catalog().filter((a) => !discover.category || a.category === discover.category);
  while (deck.length < 3) {
    const n = nextArtwork(pool, state.taste, rng, { seen, popularity: (a) => world.influence[a.id] });
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
    <span class="stamp stamp-like">Like</span><span class="stamp stamp-nope">Pass</span><span class="stamp stamp-super">Super Like</span>
    ${top ? `<button class="swipe-info icon-btn" data-act="artwork" data-id="${w.id}" aria-label="Artwork details">${Icon('info')}</button>` : ''}
    <div class="swipe-caption">
      <p class="eyebrow swipe-reason">${esc(reason)}</p>
      <h2 class="swipe-title">${esc(w.title)}</h2>
      <div class="swipe-by">
        <button class="artist-line" data-act="artist" data-id="${a.id}">${Avatar(a, 'sm')}<span><b>${esc(a.name)}</b><small>${esc(w.medium)} • ${w.year}</small></span></button>
        ${top ? `<button class="swipe-heart${r === 'like' || r === 'super' ? ' is-on' : ''}" data-act="react" data-v="like" data-id="${w.id}" aria-pressed="${r === 'like' || r === 'super'}" aria-label="Like">${Icon('heart', { size: 22 })}</button>` : ''}
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
      <div><dt>Price</dt><dd>${money(w.price)}</dd></div>
    </dl>
    <div class="panel-actions">
      ${PremiumButton('View details', { act: 'artwork', variant: 'secondary', attrs: `data-id="${w.id}"` })}
      ${PremiumButton('Inquire', { act: 'buy', variant: 'primary', attrs: `data-id="${w.id}"` })}
      ${state.user.role === 'critic' ? PremiumButton('Write review', { act: 'review', variant: 'ghost', icon: 'pen', attrs: `data-id="${w.id}"` }) : ''}
    </div>
    <p class="fine">${counts() ? `Your ${role().label.toLowerCase()} vote adds ${role().weight} influence (${role().weight * SAVE_MULTIPLIER} for a Super Like).` : '<button class="link" data-act="sign-in">Sign in</button> so your likes count in the rankings.'} Keys: ← pass, → like, ↑ Super Like, Enter for details.</p>`;
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
        ${top ? `<div class="deck-actions">
          <button class="deck-btn deck-pass" data-act="swipe" data-dir="pass" aria-label="Pass">${Icon('x', { size: 26 })}</button>
          <span class="deck-super-wrap"><button class="deck-btn deck-super" data-act="swipe" data-dir="super" aria-label="Super Like: save as a special favourite">${Icon('star', { size: 24 })}</button><small>Super Like</small></span>
          <button class="deck-btn deck-like" data-act="swipe" data-dir="like" aria-label="Like">${Icon('heart', { size: 28 })}</button>
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
  setReaction(art, action);
  if (action === 'super' && !counts()) toast(`Saved “${art.title}” to your collection`);
}

// ——— Artwork & artist modals ———
function artworkSheet(id) {
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
      <div class="panel-artist">
        <button class="artist-line" data-act="artist" data-id="${a.id}">${Avatar(a, 'sm')}<span><b>${esc(a.name)}</b><small>${esc(countryName(a.country))}</small></span></button>
        ${a.isMe ? '' : `<button class="follow-btn${following ? ' is-on' : ''}" data-act="follow" data-id="${a.id}" aria-pressed="${following}">${following ? 'Following' : 'Follow'}</button>`}
      </div>
      <dl class="spec">
        <div><dt>Medium</dt><dd>${esc(w.medium)}</dd></div>
        <div><dt>Year</dt><dd>${w.year}</dd></div>
        <div><dt>Price</dt><dd>${money(w.price)}</dd></div>
      </dl>
      <div class="detail-actions">
        <button class="btn btn-icon${r === 'like' || r === 'super' ? ' is-on' : ''}" data-act="react" data-v="like" data-id="${id}" aria-pressed="${r === 'like' || r === 'super'}" aria-label="Like">${Icon('heart', { size: 18 })}</button>
        <button class="btn btn-icon${r === 'super' ? ' is-on' : ''}" data-act="react" data-v="super" data-id="${id}" aria-pressed="${r === 'super'}" aria-label="Save to collection">${Icon('bookmark', { size: 18 })}</button>
        ${PremiumButton(state.purchases.some((p) => p.artworkId === id) ? 'Purchased' : `Inquire · ${money(w.price)}`, { act: 'buy', attrs: `data-id="${id}"` })}
        ${PremiumButton('Add to collection', { act: 'add-to-collection', variant: 'secondary', icon: 'folderPlus', attrs: `data-id="${id}"` })}
        ${state.user.role === 'critic' && !myReview ? PremiumButton('Review', { act: 'review', variant: 'secondary', icon: 'pen', attrs: `data-id="${id}"` }) : ''}
        ${isMine(w) ? PremiumButton('Delete', { act: 'delete-artwork', variant: 'ghost', attrs: `data-id="${id}" data-danger` }) : ''}
      </div>
      ${myReview ? `<blockquote class="quote"><span class="stars-static">${'★'.repeat(myReview.rating)}${'☆'.repeat(5 - myReview.rating)}</span>${esc(myReview.text)}</blockquote>` : ''}
      <div class="stat-row">
        <div><b>${globalRank}</b><small>Worldwide</small></div>
        <div><b>${countryRank}</b><small>${esc(countryName(a.country))}</small></div>
        <div><b>${catRank}</b><small>${esc(categoryById[w.category].label)}</small></div>
        <div><b>${Math.round(world.eloOf(w))}</b><small>Battle Elo</small></div>
      </div>
      <div class="influence">
        <div class="influence-head"><h3>Influence score</h3><span>${fmt(world.influence[id])}</span></div>
        ${rows.map((x) => `<div class="meter-row"><span>${esc(x.label)}</span><div class="meter"><i style="width:${(x.points / max) * 100}%"></i></div><span class="num">${fmt(x.points)}</span></div>
          <p class="meter-sub">${x.role === 'review' ? `${x.likes} reviews · average ${avg}★` : `${fmt(x.likes)} likes · ${fmt(x.saves)} saves · weight ×${ROLE_WEIGHTS[x.role]}`}</p>`).join('')}
      </div>
    </div>
  </div>`;
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
  const titles = { saved: 'Super Likes', liked: 'Liked works', purchased: 'Acquired' };
  return `<div><p class="eyebrow">Your collection</p><h2 class="display-md" id="modal-title">${titles[kind]}</h2>
    ${ids.length ? ArtworkGrid(ids.map((id) => card(world.artworkById[id])), { className: 'art-grid-tight' }) : EmptyState({ icon: 'bookmark', title: 'Nothing here yet', body: 'Save works from Discover to build your collection.' })}</div>`;
}

function userCollectionSheet(id) {
  const c = state.collections.find((x) => x.id === id);
  if (!c) return EmptyState({ title: 'Collection not found' });
  const works = c.ids.map((x) => world.artworkById[x]).filter(Boolean);
  return `<div class="user-collection"><p class="eyebrow">${c.private ? `${Icon('lock', { size: 12 })} Private collection` : 'Collection'} · on this device</p>
    <h2 class="display-md" id="modal-title">${esc(c.name)}</h2>
    <div class="detail-actions">
      ${PremiumButton(c.private ? 'Private' : 'Not private', { act: 'collection-private', variant: 'secondary', icon: 'lock', attrs: `data-v="${c.id}" aria-pressed="${c.private}"` })}
      ${PremiumButton('Delete collection', { act: 'collection-delete', variant: 'ghost', attrs: `data-v="${c.id}" data-danger` })}
    </div>
    ${works.length ? ArtworkGrid(works.map((w) => card(w)), { className: 'art-grid-tight' }) : EmptyState({ icon: 'folderPlus', title: 'Empty for now', body: 'Open any artwork and choose “Add to collection”.' })}</div>`;
}

let newCollectionFor = null;
function newCollectionSheet() {
  return `<form class="auth" id="new-collection-form"><p class="eyebrow">New collection</p><h2 class="display-md" id="modal-title">Name your collection</h2>
    <div class="chip-row chip-row-wrap">${COLLECTION_PRESETS.map((p) => `<button type="button" class="chip" data-act="collection-preset" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <label class="field"><span>Name</span><input id="collection-name" maxlength="40" autocomplete="off" placeholder="Personal Museum"></label>
    <label class="check"><input type="checkbox" id="collection-private" checked> Private</label>
    <div class="detail-actions">${PremiumButton('Create collection', { act: 'collection-create' })}</div>
    <p class="fine">Collections are saved on this device for now.</p></form>`;
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

function renderBattle(root) {
  if (!battlePair) newBattle();
  const history = (state.battles.history || []).slice(0, 6).filter((h) => world.artworkById[h.w] && world.artworkById[h.l]);
  root.innerHTML = `<div class="shell battle">
    <header class="battle-head">
      <h1 class="display-md">${Icon('trophy', { size: 26 })} Art Battle</h1>
      <p class="lede">Vote for your favourite masterpiece.</p>
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

function vote(i) {
  if (battleOutcome || !battlePair) return;
  const winner = battlePair[i], loser = battlePair[1 - i];
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
/** Rank movement compares with the chart from the start of the previous hour. No previous chart, no movement. */
function chartSnapshot() {
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
const memberCache = new Map(); // scope → { at, data, loading, error }

async function loadMembers(scope) {
  const prev = memberCache.get(scope);
  if (prev?.loading || !cloud) return;
  memberCache.set(scope, { ...prev, loading: true });
  try {
    const data = await cloud.leaderboards(scope === 'world' ? null : scope);
    memberCache.set(scope, { at: Date.now(), data, loading: false });
  } catch (e) {
    memberCache.set(scope, { ...prev, at: Date.now(), loading: false, error: e?.message || 'Leaderboards are unavailable right now.' });
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
  const entry = memberCache.get(scope);
  if (!entry || (!entry.loading && Date.now() - entry.at > 60_000)) setTimeout(() => loadMembers(scope), 0);
  const country = state.user.country;
  const pills = `<div class="chip-row pill-row" role="tablist" aria-label="Region">
    <button class="chip${scope === 'world' ? ' is-on' : ''}" role="tab" aria-selected="${scope === 'world'}" data-act="members-scope" data-v="">Worldwide</button>
    <button class="chip${scope === country ? ' is-on' : ''}" role="tab" aria-selected="${scope === country}" data-act="members-scope" data-v="${country}">${flag(country)} ${esc(countryName(country))}</button></div>`;
  if (!entry?.data) {
    return `${pills}${entry?.error ? EmptyState({ title: 'Leaderboards are unavailable', body: entry.error, action: PremiumButton('Try again', { act: 'members-retry', variant: 'secondary' }) }) : LoadingSkeleton({ cards: 5, variant: 'list' })}`;
  }
  const d = entry.data;
  const standing = me ? `<section class="standing">
      <p class="eyebrow">Your standing${scope === 'world' ? ' worldwide' : ` in ${esc(countryName(scope))}`}</p>
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
    <p class="fine explainer"><b>Discovery Score</b> rewards liking work before others do: the more weight (Fan 1 … Collector 9) that arrives after you, and the earlier you were, the higher it climbs. <b>Collectors</b> and <b>critics</b> are ranked by the influence they have added in that role; critics’ reviews count too. Members appear by display name only and can opt out in their profile. ${fmt(d.members || 0)} member${d.members === 1 ? '' : 's'} on the boards.</p>`;
}

function countryRow(row) {
  const c = countryByCode[row.country];
  const crown = row.rank === 1 ? `<span class="crown">${Icon('crown', { size: 14 })}</span>` : '';
  return `<li class="${row.rank <= 3 ? 'is-podium' : ''}"><button class="rank-row" data-act="chart-country" data-v="${row.country}">
    <span class="rank-num">${crown}${row.rank}</span><span class="country-flag">${c?.flag || ''}</span>
    <span class="rank-text"><b>${esc(c?.name || row.country)}</b><small>${row.artists} artists · led by ${esc(row.topArtist?.name || '—')}</small></span>
    <span class="rank-score">${fmt(row.score)}</span></button></li>`;
}

function renderCharts(root) {
  const previous = chartSnapshot();
  const hour = new Date();
  hour.setMinutes(0, 0, 0);
  const section = (key, title, list, kind, opts = {}) => {
    const open = charts.expanded === key;
    const rows = list.slice(0, open ? 100 : 5);
    return `<section class="board">
      <header class="board-head"><h2>${title}</h2>${list.length > 5 ? `<button class="link-arrow" data-act="chart-expand" data-v="${key}">${open ? 'Show top 5' : 'See all'} ${Icon('arrow', { size: 14 })}</button>` : ''}</header>
      ${rows.length ? `<ol class="rank-list">${rows.map((r) => rankRow(r, kind, opts.previous || undefined, opts)).join('')}</ol>` : EmptyState({ title: 'Nothing ranked here yet' })}
    </section>`;
  };
  const tabs = Object.entries({ global: 'Global', countries: 'Countries', categories: 'Categories', members: 'Members' })
    .map(([k, v]) => `<button role="tab" aria-selected="${charts.tab === k}" class="${charts.tab === k ? 'is-on' : ''}" data-act="chart-tab" data-v="${k}">${v}</button>`).join('');
  let body = '';
  if (charts.tab === 'global') {
    const standings = countryStandings(world.artists, (a) => world.artistScores[a.id], world.artworks, (w) => world.influence[w.id]);
    body = `${section('artworks', 'Top Artworks Worldwide', world.topArtworks(), 'art', { previous })}
      ${section('artists', 'Top Artists Worldwide', world.topArtists(), 'artist', { previous })}
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
      const standings = countryStandings(world.artists, (a) => world.artistScores[a.id], world.artworks, (w) => world.influence[w.id]);
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
      <div><h1 class="display-lg">Rankings</h1><p class="muted">Updated hourly · ${hour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p></div>
      ${Icon('globe', { size: 26, label: 'Worldwide' })}
    </header>
    <div class="seg seg-gold" role="tablist">${tabs}</div>
    ${body}
    <p class="fine explainer"><b>Score</b> is popularity: every like weighted by who gave it (Fan 1, Artist 3, Critic 5, Collector 9; Super Likes count ×${SAVE_MULTIPLIER}). <b>Credible</b> is the share of that score from critics and collectors. Rankings are organic: nobody can pay to move them.</p>
  </div>`;
}

// ——— Explore ———
const SORTS = {
  trending: { label: 'Trending', fn: (a, b) => world.influence[b.id] - world.influence[a.id] },
  new: { label: 'Newest', fn: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.year - a.year || world.influence[b.id] - world.influence[a.id] },
  battle: { label: 'Battle rating', fn: (a, b) => world.eloOf(b) - world.eloOf(a) },
  priceHigh: { label: 'Price: high to low', fn: (a, b) => b.price - a.price },
  priceLow: { label: 'Price: low to high', fn: (a, b) => a.price - b.price },
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
  const works = world.topArtworks().filter((r) => r.item.artistId === id);
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
            ${state.user.role === 'collector' ? PremiumButton('Sponsor', { act: 'sponsor', variant: 'secondary', attrs: `data-id="${id}"` }) : ''}
            ${IconButton('mail', `Contact ${a.name}`, { act: 'contact', attrs: `data-id="${id}"` })}`}
        </div>
        <h1 class="display-md">${esc(a.name)}</h1>
        <p class="muted">${esc(categoryById[a.category]?.label || 'Contemporary')} artist • ${esc(countryName(a.country))}${a.debutYear ? ` • since ${a.debutYear}` : ''}</p>
        <div class="signal-row">${signalChips(id)}${badges.map((b) => `<span class="badge" title="${esc(BADGES[b].desc)}">${BADGES[b].emoji} ${BADGES[b].label}</span>`).join('')}</div>
        <dl class="stat-row artist-stats">
          <div><dt>Followers</dt><dd>${fmt(followerTotal)}</dd></div>
          <div><dt>Works</dt><dd>${works.length}</dd></div>
          <div><dt>Influence</dt><dd>${fmt(world.artistScores[id])}</dd></div>
          <div><dt>Worldwide</dt><dd>No. ${world.globalArtistRanks[id]}</dd></div>
        </dl>
      </header>
      <div class="tabs" role="tablist">
        ${[['artwork', 'Artwork'], ['about', 'About']].map(([k, v]) => `<button role="tab" class="${artistTab === k ? 'is-on' : ''}" aria-selected="${artistTab === k}" data-act="artist-tab" data-v="${k}">${v}</button>`).join('')}
      </div>
      ${artistTab === 'artwork'
        ? (works.length ? ArtworkGrid(works.map((r) => card(r.item, { rank: r.rank, details: true }))) : EmptyState({ title: 'No works yet' }))
        : `<dl class="spec about-spec">
            <div><dt>Movements</dt><dd>${a.styles.length ? a.styles.map(esc).join(', ') : '—'}</dd></div>
            <div><dt>Medium</dt><dd>${esc(categoryById[a.category]?.label || '—')}</dd></div>
            <div><dt>Country</dt><dd>${flag(a.country)} ${esc(countryName(a.country))} · No. ${world.countryArtistRanks[id]}</dd></div>
            <div><dt>Credibility</dt><dd>${Math.round((cred?.share || 0) * 100)}% of influence from critics &amp; collectors</dd></div>
            <div><dt>Followers by role</dt><dd>${ROLES.map((r) => `${r.label} ${fmt(followers[r.id])}`).join(' · ')}</dd></div>
            ${a.member ? '<div><dt>Profile</dt><dd>Member artist on Abremi</dd></div>' : ''}
          </dl>`}
    </div>
  </div>`;
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
    { k: 'saved', title: 'Super Likes', ids: saved, icon: 'star', empty: 'Your special favourites' },
    { k: 'liked', title: 'Liked', ids: liked, icon: 'heart', empty: 'Start from Discover' },
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
      <div class="achievement-row">${earned.map((id) => `<span class="achievement is-earned" title="${esc(ACHIEVEMENTS[id].desc)}">${AbremiSymbol(16)} ${esc(ACHIEVEMENTS[id].label)}</span>`).join('')}</div></section>` : ''}

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
      <p class="muted">Like or Super Like ${taste.needed} more work${taste.needed === 1 ? '' : 's'} to reveal how early your eye is.</p></div>
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
  const top20 = new Set(world.topArtworks().slice(0, BADGE_RULES.trendSetterTopN).map((r) => r.item.id));
  const trendHits = [...liked, ...collected].filter((id) => top20.has(id)).length;
  const myBadges = userBadges({ role: state.user.role, collectedCount: collected.length + state.purchases.length, reviewCount: state.reviews.length, trendHits });
  const myArtist = world.artistById[myArtistId()];
  const allBadges = [...myBadges, ...(myArtist ? world.badgesOf(myArtist) : [])];
  const tasteTop = topStyles(state.taste, 5);
  const tasteTotal = tasteTop.reduce((s, k) => s + state.taste.styles[k], 0) || 1;
  const followed = Object.keys(state.follows).map((id) => world.artistById[id]).filter(Boolean);
  const myWorks = world.artworks.filter(isMine).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const canAnalyze = hasFeature(state.user.plan, 'whoLiked');

  root.innerHTML = `<div class="shell profile">
    ${accountCardHTML()}
    ${installCardHTML()}
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
      <section class="panel influence-panel">
        <p class="eyebrow">Cultural Influence</p>
        <p class="influence-total">${fmt(personalInfluence(state.interactions, state.interactionRoles, state.reviews))}</p>
        <p class="muted">The weight your likes, Super Likes and reviews add to the rankings. As a ${role().label.toLowerCase()}, each like adds ${role().weight}.</p>
      </section>
    </div>

    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Recognition', title: 'Achievements' })}
      <div class="achievement-grid">${(() => {
        const earned = new Set(myAchievements());
        return Object.entries(ACHIEVEMENTS).map(([k, a]) => `<div class="achievement-card${earned.has(k) ? ' is-earned' : ''}">
          <span class="achievement-mark">${earned.has(k) ? AbremiSymbol(18) : Icon('lock', { size: 16 })}</span>
          <b>${esc(a.label)}</b><small>${esc(a.desc)}</small></div>`).join('');
      })()}</div>
    </section>

    <div class="profile-grid">
      <section class="panel">
        <h3 class="sub-head">Role</h3>
        <div class="role-grid">${ROLES.map((r) => `<button class="role-card${r.id === state.user.role ? ' is-on' : ''}" data-act="set-role" data-v="${r.id}" aria-pressed="${r.id === state.user.role}">
          <span class="role-top"><b>${r.label}</b><span class="role-weight">×${r.weight}</span></span><small>${esc(r.blurb)}</small>
          ${COMMUNITY && (r.id === 'critic' || r.id === 'collector') && r.id !== state.user.role ? '<span class="role-lock">Verification required</span>' : ''}</button>`).join('')}</div>
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

    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Membership', title: 'Plans' })}
      <div class="plan-grid">${PLANS.map((p) => `<div class="plan${p.id === state.user.plan ? ' is-on' : ''}">
        <p class="plan-name">${p.name}</p><p class="plan-price">${p.price ? `${money(p.price)}<small>/month</small>` : 'Free'}</p>
        <ul>${p.features.map((x) => `<li>${Icon('check', { size: 16 })}${esc(x)}</li>`).join('')}</ul>
        ${p.id === state.user.plan ? '<span class="tag tag-gold">Current plan</span>' : PremiumButton(`Choose ${p.name}`, { act: 'set-plan', variant: p.id === 'pro' ? 'primary' : 'secondary', attrs: `data-v="${p.id}"` })}</div>`).join('')}</div>
      <p class="fine">Artists pay nothing to start. Abremi earns from memberships and a 5–10% marketplace commission.</p>
    </section>

    <div class="profile-foot">${PremiumButton('About Abremi', { act: 'about', variant: 'ghost' })}${PremiumButton('Reset demo data', { act: 'reset', variant: 'ghost', attrs: 'data-danger' })}</div>
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
    ${SectionHeader({ eyebrow: 'Studio', title: 'Your work' })}
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
      await cloud.publishArtwork({ ...prepared, ...meta, medium });
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
  return `<div class="about">
    <p class="eyebrow">About</p><h2 class="display-md" id="modal-title">Abremi</h2>
    <p class="lede">The Tinder and TikTok of art, curated like a private gallery.</p>
    <p>People don't wake up saying “I want to upload art.” They wake up saying <em>“Show me something amazing.”</em> Abremi makes finding art addictive. You swipe through paintings, photography, sculpture, street art, NFTs and AI art, discover emerging artists, and your taste moves the rankings.</p>
    <h3 class="sub-head">Weighted influence</h3>
    <p>100 fan likes (100) + 20 artist likes (60) + 10 critic likes (50) + 5 collector likes (45) = <b>255 influence</b>. Collectors and critics shape the rankings, so throwaway accounts barely move them.</p>
    <h3 class="sub-head">Artwork first</h3>
    <p>People fall in love with a painting before they fall in love with the painter, so the leading ranking is of works, not names.</p>
  </div>`;
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
function notifications() {
  const items = [];
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

// ——— Install as an app ———
function installCardHTML() {
  const st = pwa?.status();
  if (!st?.available) return '';
  return `<section class="install-card">
    <img src="icons/icon-192.png" alt="" width="56" height="56" class="install-icon">
    <div><p class="eyebrow">Abremi app</p><p><b>Put Abremi on your home screen</b></p>
    <p class="muted">Full screen, one tap away, and it works offline.</p></div>
    ${PremiumButton(st.canPrompt ? 'Install' : 'How to install', { act: 'pwa-install', variant: 'secondary', icon: 'download' })}
  </section>`;
}

function iosInstallSheet() {
  return `<div class="install-guide">
    <p class="eyebrow">Install Abremi</p>
    <h2 class="display-md" id="modal-title">Add it to your Home Screen</h2>
    <ol class="steps">
      <li><span class="step-icon">${Icon('share', { size: 22 })}</span><div><b>Tap Share</b><small>The square with an arrow, in Safari’s toolbar. On iPad it’s at the top.</small></div></li>
      <li><span class="step-icon">${Icon('plusSquare', { size: 22 })}</span><div><b>Choose “Add to Home Screen”</b><small>Scroll down the list if you don’t see it.</small></div></li>
      <li><span class="step-icon"><img src="icons/icon-192.png" alt="" width="26" height="26"></span><div><b>Tap Add</b><small>Abremi opens full screen, like any other app.</small></div></li>
    </ol>
    <p class="fine">Don’t see Share? Open <b>${esc(location.host)}</b> in Safari. Apps like Instagram use their own browser, which can’t install apps.</p>
  </div>`;
}

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
  if (auth.stage === 'sent') {
    return `<div class="auth">
      <p class="eyebrow">Check your inbox</p>
      <h2 class="display-md" id="modal-title">One tap to sign in</h2>
      ${pwa?.status().standalone
        ? `<p class="muted">We emailed <b>${esc(auth.email)}</b>. Type the code from the email below. In the home-screen app, the link would open your browser instead.</p>`
        : `<p class="muted">We sent a sign-in link to <b>${esc(auth.email)}</b>. Open it on this device and you’re in.</p>`}
      <label class="field"><span>Or enter the code from the email</span>
        <input id="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"></label>
      ${auth.error ? `<p class="form-error" role="alert">${esc(auth.error)}</p>` : ''}
      <div class="detail-actions">
        ${PremiumButton(auth.busy ? 'Checking…' : 'Verify code', { act: 'verify-code', attrs: auth.busy ? 'disabled' : '' })}
        ${PremiumButton('Use a different email', { act: 'auth-back', variant: 'ghost' })}
      </div>
      <p class="fine">No email after a minute? Check spam, or go back and send it again.</p>
    </div>`;
  }
  const local = Object.values(state.interactions).filter((k) => k === 'like' || k === 'super').length;
  return `<div class="auth">
    <p class="eyebrow">Join Abremi</p>
    <h2 class="display-md" id="modal-title">Make your taste count</h2>
    <p class="muted">Members’ likes, saves, follows and battle votes shape the global rankings. Sign in with your email. There’s no password to remember.</p>
    <label class="field"><span>Email</span>
      <input id="auth-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${esc(auth.email)}"></label>
    ${auth.error ? `<p class="form-error" role="alert">${esc(auth.error)}</p>` : ''}
    <div class="detail-actions">${PremiumButton(auth.busy ? 'Sending…' : 'Email me a sign-in link', { act: 'send-link', size: 'lg', attrs: auth.busy ? 'disabled' : '' })}</div>
    ${local ? `<p class="fine">The ${local} work${local === 1 ? '' : 's'} you liked or saved on this device will be added to your account.</p>` : ''}
  </div>`;
}

async function sendLink() {
  const email = ($('#auth-email')?.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    Object.assign(auth, { error: 'Enter a valid email address.' });
    return refreshSheet();
  }
  Object.assign(auth, { email, busy: true, error: '' });
  refreshSheet();
  try {
    await cloud.sendLink(email);
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
    toast(imported ? `Welcome. ${imported} item${imported === 1 ? '' : 's'} from this device added to your account.` : 'Welcome to Abremi. Your votes now count.', { force: true, duration: 3500 });
  } catch {
    toast('Signed in, but your account could not be loaded. Reload to try again.', { force: true });
  }
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
  state.user = { ...state.user, name: profile.name, country: profile.country, role: profile.role, publicLeaderboards: profile.public_leaderboards !== false };
  memberCache.clear();
  state.account = { id: me.id, email: me.email };
  deck = [];
  await refreshCommunity();
  return imported;
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
  if (!sheetRenderer) renderView();
  else refresh();
  const quietRefresh = () => {
    if (document.hidden || !cloud) return;
    refreshCommunity()
      .then(() => {
        const passive = ['home', 'charts', 'explore', 'artists', 'collections'].includes(currentView());
        if (passive && !sheetRenderer && !document.activeElement?.matches('input, textarea, select')) renderView();
      })
      .catch(() => {});
  };
  setInterval(quietRefresh, 90_000);
  document.addEventListener('visibilitychange', quietRefresh);
}

function accountCardHTML() {
  const members = state.community?.members || 0;
  if (!COMMUNITY) {
    return `<section class="account-card"><div><p class="eyebrow">Demo mode</p><p class="muted">Everything you do is saved on this device only.</p></div></section>`;
  }
  if (!me) {
    return `<section class="account-card is-invite">
      <div><p class="eyebrow">Community</p><h3 class="display-sm">Make your taste count</h3>
      <p class="muted">Sign in so your likes, saves, follows and battle votes count in the global rankings${members ? `, alongside ${fmt(members)} member${members === 1 ? '' : 's'}` : ''}.</p></div>
      ${PremiumButton('Sign in with email', { act: 'sign-in', size: 'lg' })}
    </section>`;
  }
  return `<section class="account-card">
    <div><p class="eyebrow">Signed in</p><p><b>${esc(me.email || 'Member')}</b></p>
    <p class="muted">Synced with the community${members ? ` · ${fmt(members)} member${members === 1 ? '' : 's'}` : ''}</p></div>
    <div class="account-actions">
      <label class="check"><input type="checkbox" id="public-leaderboards" ${state.user.publicLeaderboards !== false ? 'checked' : ''}> Appear on member leaderboards</label>
      ${PremiumButton('Sign out', { act: 'sign-out', variant: 'secondary' })}
    </div>
  </section>`;
}

// ——— Actions ———
const ACTIONS = {
  swipe: (el) => decide(el.dataset.dir),
  react: (el) => react(world.artworkById[el.dataset.id], el.dataset.v),
  artwork: (el) => { closePopovers(); openSheet(() => artworkSheet(el.dataset.id), { wide: true }); },
  artist: (el) => { closePopovers(); openArtist(el.dataset.id); },
  back: () => (history.length > 1 ? history.back() : (location.hash = 'artists')),
  'artist-tab': (el) => { artistTab = el.dataset.v; renderView(); },
  'share-artist': async (el) => {
    const a = world.artistById[el.dataset.id];
    const url = `${location.origin}${location.pathname}#artist/${encodeURIComponent(el.dataset.id)}`;
    try {
      if (navigator.share) await navigator.share({ title: `${a.name} on Abremi`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied', { force: true }); }
    } catch { /* share sheet dismissed */ }
  },
  'discover-cat': (el) => { discover.category = el.dataset.v; deck = []; renderView(); },
  'members-scope': (el) => { charts.memberCountry = el.dataset.v; renderView(); },
  'members-retry': () => { memberCache.delete(charts.memberCountry || 'world'); renderView(); },
  'chart-expand': (el) => { charts.expanded = charts.expanded === el.dataset.v ? '' : el.dataset.v; renderView(); },
  'chart-country': (el) => { Object.assign(charts, { tab: 'countries', country: el.dataset.v, expanded: '' }); renderView(); window.scrollTo(0, 0); },
  'charts-goto': (el) => { Object.assign(charts, { tab: el.dataset.v, country: '', expanded: '' }); location.hash = 'charts'; },
  'add-to-collection': (el) => openSheet(() => addToCollectionSheet(el.dataset.id)),
  'new-collection': (el) => { newCollectionFor = el.dataset.id || null; openSheet(newCollectionSheet); setTimeout(() => $('#collection-name')?.focus(), 50); },
  'collection-preset': (el) => { const i = $('#collection-name'); i.value = el.dataset.v; i.focus(); },
  'collection-create': () => {
    const name = ($('#collection-name')?.value || '').trim().slice(0, 40);
    if (!name) return toast('Give the collection a name.', { force: true });
    const c = { id: `c${Date.now().toString(36)}`, name, private: $('#collection-private')?.checked !== false, ids: newCollectionFor ? [newCollectionFor] : [], at: Date.now() };
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
    c.ids = c.ids.includes(id) ? c.ids.filter((x) => x !== id) : [id, ...c.ids];
    saveState(state);
    checkAchievements();
    refresh();
  },
  'open-user-collection': (el) => openSheet(() => userCollectionSheet(el.dataset.v), { wide: true }),
  'collection-private': (el) => { const c = state.collections.find((x) => x.id === el.dataset.v); if (c) { c.private = !c.private; saveState(state); refresh(); } },
  'collection-delete': (el) => {
    const c = state.collections.find((x) => x.id === el.dataset.v);
    if (!c || !confirm(`Delete the collection “${c.name}”? The works stay on Abremi.`)) return;
    state.collections = state.collections.filter((x) => x !== c);
    saveState(state);
    closeSheet();
    renderView();
  },
  buy: (el) => el.dataset.id && world.artworkById[el.dataset.id] && openSheet(() => buySheet(el.dataset.id)),
  contact: (el) => openSheet(() => contactSheet(el.dataset.id)),
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
      if (next === 'critic' || next === 'collector') {
        return toast(`${next === 'critic' ? 'Critic' : 'Collector'} status needs verification, so your votes stay trustworthy. Applications open soon.`, { duration: 4000 });
      }
      const before = state.user.role;
      state.user.role = next;
      commit();
      renderView();
      pendingWrites++;
      cloud.updateProfile({ role: next })
        .then(() => toast(`You’re now a ${role().label}. Your votes count ×${role().weight}.`))
        .catch((e) => { state.user.role = before; commit(); renderView(); toast(e?.message || 'Could not change your role.'); })
        .finally(() => { pendingWrites--; });
      return;
    }
    state.user.role = next;
    commit();
    toast(`You’re now a ${role().label}. Your votes count ×${role().weight}.`);
    renderView();
  },
  'set-plan': (el) => { state.user.plan = el.dataset.v; commit(); toast(`Switched to ${PLANS.find((p) => p.id === el.dataset.v).name} (demo, no charge)`); renderView(); },
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

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, textarea, select');
  if (e.key === 'Escape') {
    if (!$('#search').hidden) return closeSearch();
    if (sheetRenderer) return closeSheet();
    return closePopovers();
  }
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
