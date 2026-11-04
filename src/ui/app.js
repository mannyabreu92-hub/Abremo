import { buildSeedWorld, CATEGORIES, STYLES, COUNTRIES, PALETTES, CURRENT_YEAR, categoryById, countryByCode } from '../core/seed.js';
import { ROLES, ROLE_WEIGHTS, SAVE_MULTIPLIER, influenceBreakdown, emptyRoleCounts } from '../core/scoring.js';
import { battleResult, expectedScore, pickBattlePair, kFactor, LOSS_FACTOR, START_RATING } from '../core/elo.js';
import { nextArtwork, updateTaste, topStyles, EXPLOIT_RATIO } from '../core/feed.js';
import { PLANS, checkoutBreakdown, hasFeature } from '../core/marketplace.js';
import { BADGES, BADGE_RULES, userBadges } from '../core/badges.js';
import { rank, rankMap, movement, rollSnapshot, hourKey } from '../core/rankings.js';
import { extractFeatures, classifyStyle, guessMedium, similarArtists } from '../core/recognition.js';
import { createWorld } from '../core/world.js';
import { mulberry32 } from '../core/random.js';
import { artSVG } from './art.js';
import { loadState, saveState, resetState } from './store.js';
import { createSupabaseCloud } from './cloud.js';
import { initPWA } from './pwa.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { emptyCommunity, snapshotToCommunity, mineToState, guestContributions } from '../core/community.js';
import {
  esc, fmt, money, flag, countryName, initials, Icon, ArtImage, Avatar, PremiumButton, IconButton,
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
  return { ...state, deltas: c.deltas, elo: c.elo, followerDeltas: c.followerDeltas };
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
const charts = { tab: 'artworks', scope: 'global', category: '' };
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
const catalog = () => world.artworks.filter((a) => a.artistId !== 'me');
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
  collections: renderCollections, charts: renderCharts, scan: renderScan, profile: renderProfile,
};
const currentView = () => (VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'home');

function renderView() {
  const name = currentView();
  $$('[data-view]').forEach((a) => {
    const on = a.dataset.view === name;
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
  if (document.startViewTransition && !reducedMotion.matches) document.startViewTransition(swap);
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
  commit();
  if (COMMUNITY && !art.image) {
    if (me) remote(() => cloud.setReaction(id, next || null));
    else if (next === 'like' || next === 'super') nudgeSignIn('likes');
  }
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
  if (next === 'super') toast(`Saved “${art.title}” to your collection`);
  else if (next === 'like') {
    toast(counts() ? `Liked · +${ROLE_WEIGHTS[state.user.role]} influence` : 'Liked');
  }
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
function renderHome(root) {
  const top = world.topArtworks();
  const [first, second, third] = top.map((r) => r.item);
  const feedSource = homeFeed.mode === 'new'
    ? catalog().slice().sort((a, b) => b.year - a.year || world.influence[b.id] - world.influence[a.id])
    : top.map((r) => r.item);
  const feed = feedSource.filter((w) => !homeFeed.category || w.category === homeFeed.category).slice(0, 8);
  const artists = world.topArtists().map((r) => r.item).filter((a) => !a.isMe).slice(0, 4);
  if (!battlePair) newBattle();
  const totals = { works: catalog().length, artists: world.artists.filter((a) => !a.isMe).length, countries: COUNTRIES.length };

  root.innerHTML = `<div class="shell home">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Art discovery, ranked by taste</p>
        <h1 class="display-xl">Find the work<br><em>that stops you.</em></h1>
        <p class="lede">Abremi is a private view of the world's emerging art. Swipe through paintings, photography, sculpture and new media. Collectors, critics and artists shape the rankings, so what rises has earned it.</p>
        <div class="hero-actions">
          <a class="btn btn-primary btn-lg" href="#discover"><span>Start discovering</span>${Icon('arrow', { size: 18 })}</a>
          <a class="btn btn-secondary btn-lg" href="#battle"><span>Enter an Art Battle</span></a>
        </div>
        ${pwa?.status().available ? `<button class="link-arrow get-app" data-act="pwa-install">${Icon('download', { size: 16 })} Get the Abremi app</button>` : ''}
        <dl class="hero-stats">
          <div><dt>Works</dt><dd>${totals.works}</dd></div>
          <div><dt>Artists</dt><dd>${totals.artists}</dd></div>
          <div><dt>Countries</dt><dd>${totals.countries}</dd></div>
          ${COMMUNITY && state.community?.members ? `<div><dt>Members</dt><dd>${fmt(state.community.members)}</dd></div>` : ''}
        </dl>
      </div>
      <div class="hero-visual" aria-label="Top works this hour">
        <button class="hero-piece hero-a" data-act="artwork" data-id="${first.id}">${ArtImage(first, { eager: true })}<span class="hero-label"><b>${esc(first.title)}</b><small>${esc(artistOf(first).name)}</small></span></button>
        <button class="hero-piece hero-b" data-act="artwork" data-id="${second.id}">${ArtImage(second, { eager: true })}</button>
        <button class="hero-piece hero-c" data-act="artwork" data-id="${third.id}">${ArtImage(third, { eager: true })}</button>
      </div>
    </section>

    ${FeaturedArtwork(first, { artist: artistOf(first), label: 'Artwork of the hour · No. 1 worldwide', reaction: reactionOf(first.id), influence: world.influence[first.id] })}

    <section class="section">
      ${SectionHeader({ eyebrow: 'Discover', title: homeFeed.mode === 'new' ? 'New discoveries' : 'Trending now', action: `<div class="seg seg-sm" role="tablist">
        <button role="tab" class="${homeFeed.mode === 'trending' ? 'is-on' : ''}" aria-selected="${homeFeed.mode === 'trending'}" data-act="home-mode" data-v="trending">Trending</button>
        <button role="tab" class="${homeFeed.mode === 'new' ? 'is-on' : ''}" aria-selected="${homeFeed.mode === 'new'}" data-act="home-mode" data-v="new">New</button></div>` })}
      ${CategoryFilter(CATEGORIES, homeFeed.category, { act: 'home-cat', allLabel: 'All mediums' })}
      ${feed.length ? ArtworkGrid(feed.map((w) => card(w))) : EmptyState({ title: 'Nothing here yet', body: 'Try another medium.' })}
      <div class="section-foot"><a class="link-arrow" href="#explore">Explore all works ${Icon('arrow', { size: 16 })}</a></div>
    </section>

    <section class="section">
      ${SectionHeader({ eyebrow: 'Featured creators', title: 'Artists to know', action: `<a class="link-arrow" href="#artists">All artists ${Icon('arrow', { size: 16 })}</a>` })}
      <div class="artist-grid">${artists.map((a) => ArtistCard(a, { cover: coverOf(a.id), following: !!state.follows[a.id], rank: world.globalArtistRanks[a.id] })).join('')}</div>
    </section>

    <section class="section battle-section">
      ${SectionHeader({ eyebrow: 'Art Battles', title: 'Which one moves you?', action: `<a class="link-arrow" href="#battle">Open the arena ${Icon('arrow', { size: 16 })}</a>` })}
      ${battleArenaHTML(true)}
    </section>

    <section class="section">
      ${SectionHeader({ eyebrow: 'Rankings', title: 'Top works worldwide', action: `<a class="link-arrow" href="#charts">Full rankings ${Icon('arrow', { size: 16 })}</a>` })}
      <ol class="rank-list">${top.slice(0, 5).map((r) => rankRow(r, 'art', undefined)).join('')}</ol>
    </section>

    ${footerHTML()}
  </div>`;
}

function footerHTML() {
  return `<footer class="footer"><span class="brand-word">Abremi</span><span>Every work, ranked by taste.</span><button class="link" data-act="about">About</button></footer>`;
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

function swipeCardHTML({ artwork: w, reason }, top) {
  const a = artistOf(w);
  return `<article class="swipe-card${top ? ' is-top' : ''}" data-id="${w.id}" ${top ? '' : 'aria-hidden="true"'}>
    <div class="swipe-art">${ArtImage(w, { eager: true })}</div>
    <span class="stamp stamp-like">Like</span><span class="stamp stamp-nope">Pass</span><span class="stamp stamp-super">Saved</span>
    ${top ? `<button class="swipe-info icon-btn" data-act="artwork" data-id="${w.id}" aria-label="Artwork details">${Icon('info')}</button>` : ''}
    <div class="swipe-caption">
      <p class="eyebrow">${esc(reason)}</p>
      <h2 class="display-md">${esc(w.title)}</h2>
      <p class="swipe-meta"><button class="link" data-act="artist" data-id="${a.id}">${esc(a.name)}</button><span>${esc(w.medium)}, ${w.year}</span></p>
    </div>
  </article>`;
}

function discoverPanelHTML(entry) {
  if (!entry) return '';
  const w = entry.artwork, a = artistOf(w);
  const following = !!state.follows[a.id];
  const globalRank = world.topArtworks().find((r) => r.item.id === w.id)?.rank;
  return `<p class="eyebrow">Now viewing</p>
    <h2 class="display-sm">${esc(w.title)}</h2>
    <div class="panel-artist">
      <button class="artist-line" data-act="artist" data-id="${a.id}">${Avatar(a, 'sm')}<span><b>${esc(a.name)}</b><small>${esc(countryName(a.country))}</small></span></button>
      <button class="follow-btn${following ? ' is-on' : ''}" data-act="follow" data-id="${a.id}" aria-pressed="${following}">${following ? 'Following' : 'Follow'}</button>
    </div>
    <dl class="spec spec-stack">
      <div><dt>Medium</dt><dd>${esc(w.medium)}</dd></div>
      <div><dt>Movement</dt><dd>${esc(w.style)}</dd></div>
      <div><dt>Ranking</dt><dd>No. ${globalRank} worldwide</dd></div>
      <div><dt>Influence</dt><dd>${fmt(world.influence[w.id])}</dd></div>
      <div><dt>Price</dt><dd>${money(w.price)}</dd></div>
    </dl>
    <div class="panel-actions">
      ${PremiumButton('View details', { act: 'artwork', variant: 'secondary', attrs: `data-id="${w.id}"` })}
      ${PremiumButton('Inquire', { act: 'buy', variant: 'primary', attrs: `data-id="${w.id}"` })}
      ${state.user.role === 'critic' ? PremiumButton('Write review', { act: 'review', variant: 'ghost', icon: 'pen', attrs: `data-id="${w.id}"` }) : ''}
    </div>
    <p class="fine">${counts() ? `Your ${role().label.toLowerCase()} vote counts ×${role().weight}.` : '<button class="link" data-act="sign-in">Sign in</button> so your likes count in the rankings.'} Use ← → to pass or like, and ↑ to save.</p>`;
}

function renderDiscover(root) {
  fillDeck();
  const top = deck[0];
  root.innerHTML = `<div class="shell discover">
    <header class="page-head page-head-row">
      <div><p class="eyebrow">Discover</p><h1 class="display-md">Curated for your eye</h1></div>
      ${Select('discover-cat', [{ value: '', label: 'All mediums' }, ...CATEGORIES.map((c) => ({ value: c.id, label: c.label }))], discover.category, 'Filter by medium')}
    </header>
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
          <button class="deck-btn deck-pass" data-act="swipe" data-dir="pass" aria-label="Pass">${Icon('x', { size: 24 })}</button>
          <button class="deck-btn deck-save" data-act="swipe" data-dir="super" aria-label="Save to collection">${Icon('bookmark', { size: 20 })}</button>
          <button class="deck-btn deck-like" data-act="swipe" data-dir="like" aria-label="Like">${Icon('heart', { size: 26 })}</button>
          <button class="deck-btn deck-more" data-act="artwork" data-id="${top.artwork.id}" aria-label="Details and inquire">${Icon('info', { size: 20 })}</button>
        </div>` : ''}
      </div>
      <aside class="discover-panel" aria-live="polite">${discoverPanelHTML(top)}</aside>
    </div>
  </div>`;
  $('#discover-cat', root).addEventListener('change', (e) => { discover.category = e.target.value; deck = []; renderView(); });
  const c = $('.swipe-card.is-top', root);
  if (c) attachDrag(c);
}

function attachDrag(cardEl) {
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
  const stamps = { like: $('.stamp-like', cardEl), nope: $('.stamp-nope', cardEl), super: $('.stamp-super', cardEl) };
  cardEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
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
  if (action === 'super') toast(`Saved “${art.title}” to your collection`);
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
        ${state.user.role === 'critic' && !myReview ? PremiumButton('Review', { act: 'review', variant: 'secondary', icon: 'pen', attrs: `data-id="${id}"` }) : ''}
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

function artistSheet(id) {
  const a = world.artistById[id];
  const works = world.topArtworks().filter((r) => r.item.artistId === id);
  const followers = world.followersOf(a);
  const following = !!state.follows[id];
  const badges = world.badgesOf(a);
  return `<div class="artist-profile">
    <header class="artist-hero">
      ${Avatar(a, 'xl')}
      <div>
        <p class="eyebrow">${esc(categoryById[a.category]?.label || 'Artist')}${a.debutYear ? ` · Since ${a.debutYear}` : ''}</p>
        <h2 class="display-md" id="modal-title">${esc(a.name)}</h2>
        <p class="muted">${esc(countryName(a.country))}${a.styles.length ? ` · ${a.styles.map(esc).join(', ')}` : ''}</p>
      </div>
    </header>
    ${badges.length ? `<div class="badge-row">${badges.map((b) => `<span class="badge" title="${esc(BADGES[b].desc)}">${BADGES[b].emoji} ${BADGES[b].label}</span>`).join('')}</div>` : ''}
    <div class="stat-row">
      <div><b>${fmt(world.artistScores[id])}</b><small>Artist score</small></div>
      <div><b>${world.globalArtistRanks[id]}</b><small>Worldwide</small></div>
      <div><b>${world.countryArtistRanks[id]}</b><small>${esc(countryName(a.country))}</small></div>
      <div><b>${fmt(Object.values(followers).reduce((s, n) => s + n, 0))}</b><small>Followers</small></div>
    </div>
    <p class="fine">Followers by role: ${ROLES.map((r) => `${r.label} ${fmt(followers[r.id])}`).join(' · ')}</p>
    ${a.isMe ? '' : `<div class="detail-actions">
      <button class="btn ${following ? 'btn-secondary' : 'btn-primary'}" data-act="follow" data-id="${id}" aria-pressed="${following}">${Icon(following ? 'check' : 'plus', { size: 18 })}<span>${following ? 'Following' : 'Follow their journey'}</span></button>
      ${state.user.role === 'collector' ? PremiumButton('Sponsor', { act: 'sponsor', variant: 'secondary', attrs: `data-id="${id}"` }) : ''}
      ${PremiumButton('Contact', { act: 'contact', variant: 'ghost', icon: 'mail', attrs: `data-id="${id}"` })}
    </div>`}
    <h3 class="sub-head">Works</h3>
    ${ArtworkGrid(works.map((r) => card(r.item, { rank: r.rank })), { className: 'art-grid-tight' })}
  </div>`;
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
  const titles = { saved: 'Saved works', liked: 'Liked works', purchased: 'Purchased' };
  return `<div><p class="eyebrow">Your collection</p><h2 class="display-md" id="modal-title">${titles[kind]}</h2>
    ${ids.length ? ArtworkGrid(ids.map((id) => card(world.artworkById[id])), { className: 'art-grid-tight' }) : EmptyState({ icon: 'bookmark', title: 'Nothing here yet', body: 'Save works from Discover to build your collection.' })}</div>`;
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
  root.innerHTML = `<div class="shell battle">
    <header class="page-head page-head-center">
      <p class="eyebrow">Art Battles</p>
      <h1 class="display-lg">Which one moves you?</h1>
      <p class="lede">Two works, one vote. Winners gain rating, and losers drop only ${LOSS_FACTOR * 100}% as much.</p>
      <dl class="inline-stats">
        <div><dt>Your votes</dt><dd>${state.battles.voted}</dd></div>
        <div><dt>Crowd streak</dt><dd>${state.battles.streak}</dd></div>
        <div><dt>Vote weight</dt><dd>K ${kFactor(state.user.role)}</dd></div>
      </dl>
    </header>
    ${battleArenaHTML()}
    <p class="fine center">Use ← and → to vote with the keyboard.</p>
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
function chartSnapshot() {
  const current = { art: rankMap(world.topArtworks()), artist: rankMap(world.topArtists()) };
  let stored = state.snapshot;
  if (!stored) {
    // Synthesize the previous hour so the first visit already shows chart movement.
    const r = mulberry32(hourKey());
    const jitter = () => 0.85 + r() * 0.3;
    stored = {
      hour: hourKey(),
      ranks: current,
      prev: {
        art: rankMap(rank(world.artworks, (w) => world.influence[w.id] * jitter())),
        artist: rankMap(rank(world.artists, (a) => world.artistScores[a.id] * jitter())),
      },
    };
  }
  const { snapshot, previous } = rollSnapshot(stored, current);
  if (snapshot !== state.snapshot) { state.snapshot = snapshot; saveState(state); }
  return previous;
}

function rankRow(r, kind, previous, { elo = false } = {}) {
  const move = previous === undefined ? '' : Movement(previous ? movement(r.item.id, r.rank, previous[kind]) : null);
  if (kind === 'artist') {
    const a = r.item;
    const badges = world.badgesOf(a).map((b) => BADGES[b].emoji).join(' ');
    return `<li><button class="rank-row" data-act="artist" data-id="${a.id}">
      <span class="rank-num">${r.rank}</span>${previous !== undefined ? move : ''}
      ${Avatar(a, 'md')}<span class="rank-text"><b>${esc(a.name)}${a.isMe ? ' <em>you</em>' : ''}</b><small>${esc(countryName(a.country))} · ${esc(categoryById[a.category]?.label || '')}${badges ? ` · ${badges}` : ''}</small></span>
      <span class="rank-score">${fmt(r.score)}</span></button></li>`;
  }
  const w = r.item, a = artistOf(w);
  return `<li><button class="rank-row" data-act="artwork" data-id="${w.id}">
    <span class="rank-num">${r.rank}</span>${previous !== undefined ? move : ''}
    <span class="rank-thumb">${ArtImage(w)}</span><span class="rank-text"><b>${esc(w.title)}</b><small>${esc(a.name)} · ${esc(categoryById[w.category].label)}</small></span>
    <span class="rank-score">${elo ? Math.round(r.score) : fmt(r.score)}</span></button></li>`;
}

function renderCharts(root) {
  const previous = chartSnapshot();
  const country = charts.scope === 'global' ? null : charts.scope;
  const opts = { country, category: charts.category || null };
  const showMove = !country && !charts.category && charts.tab !== 'elo';
  const titles = { artworks: 'Top artworks', artists: 'Top artists', elo: 'Battle champions' };
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const prev = showMove ? previous : undefined;

  let body;
  if (charts.tab === 'artists') {
    const list = world.topArtists(opts).slice(0, 50);
    body = list.length ? `<ol class="rank-list">${list.map((r) => rankRow(r, 'artist', prev)).join('')}</ol>` : EmptyState({ title: 'No artists here yet' });
  } else {
    const list = (charts.tab === 'elo' ? world.topElo(opts) : world.topArtworks(opts)).slice(0, 50);
    const podium = list.slice(0, 3);
    body = list.length ? `<div class="podium">${podium.map((r) => card(r.item, { rank: r.rank, score: charts.tab === 'elo' ? Math.round(r.score) : fmt(r.score), eager: true })).join('')}</div>
      <ol class="rank-list" start="4">${list.slice(3).map((r) => rankRow(r, 'art', prev, { elo: charts.tab === 'elo' })).join('')}</ol>` : EmptyState({ title: 'No works here yet' });
  }

  root.innerHTML = `<div class="shell charts">
    <header class="page-head page-head-row">
      <div><p class="eyebrow">Rankings · updated hourly · ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      <h1 class="display-lg">${titles[charts.tab]}</h1>
      <p class="muted">${country ? `${flag(country)} ${esc(countryName(country))}` : 'Worldwide'}${charts.category ? ` · ${esc(categoryById[charts.category].label)}` : ''}</p></div>
      <div class="seg" role="tablist">${Object.entries({ artworks: 'Artworks', artists: 'Artists', elo: 'Battles' }).map(([k, v]) => `<button role="tab" aria-selected="${charts.tab === k}" class="${charts.tab === k ? 'is-on' : ''}" data-act="chart-tab" data-v="${k}">${v}</button>`).join('')}</div>
    </header>
    <div class="toolbar">
      ${Select('scope', [{ value: 'global', label: 'Worldwide' }, ...COUNTRIES.map((c) => ({ value: c.code, label: `${c.name}${c.code === state.user.country ? ' (you)' : ''}` }))], charts.scope, 'Region')}
      ${CategoryFilter(CATEGORIES, charts.category, { act: 'chart-cat' })}
    </div>
    ${body}
    <p class="fine explainer">Influence adds up each like times the role's weight (Fan 1, Artist 3, Critic 5, Collector 9). Saves count ×${SAVE_MULTIPLIER}, and a critic review is worth up to ${ROLE_WEIGHTS.critic * 2}. The weighting makes fake popularity expensive.</p>
  </div>`;
  $('#scope', root).addEventListener('change', (e) => { charts.scope = e.target.value; renderView(); });
}

// ——— Explore ———
const SORTS = {
  trending: { label: 'Trending', fn: (a, b) => world.influence[b.id] - world.influence[a.id] },
  new: { label: 'Newest', fn: (a, b) => b.year - a.year || world.influence[b.id] - world.influence[a.id] },
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
  const mine = ['saved', 'liked', 'purchased'].map((k) => ({ k, ids: collectionIds(k) }));
  const titles = { saved: 'Saved works', liked: 'Liked', purchased: 'Purchased' };
  const top = world.topArtworks().map((r) => r.item).filter((w) => w.artistId !== 'me');
  const editions = STYLES.map((s) => ({ s, works: top.filter((w) => w.style === s) })).filter((x) => x.works.length >= 4);
  const countries = COUNTRIES.map((c) => ({ c, works: top.filter((w) => artistOf(w).country === c.code) }));
  root.innerHTML = `<div class="shell collections">
    <header class="page-head"><p class="eyebrow">Collections</p><h1 class="display-lg">Your collection,<br><em>and ours.</em></h1></header>
    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Private', title: 'Your collection' })}
      <div class="collection-grid">${mine.map(({ k, ids }) => ids.length
        ? CollectionCard({ title: titles[k], subtitle: `${ids.length} work${ids.length === 1 ? '' : 's'}`, works: ids.map((id) => world.artworkById[id]), act: 'open-collection', attrs: `data-v="${k}"` })
        : `<div class="collection-card is-empty"><div class="mosaic mosaic-empty">${Icon(k === 'liked' ? 'heart' : k === 'saved' ? 'bookmark' : 'collection', { size: 26 })}</div><span class="collection-text"><b>${titles[k]}</b><small>${k === 'purchased' ? 'Works you acquire appear here' : 'Start from Discover'}</small></span></div>`).join('')}</div>
    </section>
    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Curated', title: 'Movements' })}
      <div class="collection-grid">${editions.map(({ s, works }) => CollectionCard({ title: `The ${s} edit`, subtitle: `${works.length} works`, works, act: 'open-style', attrs: `data-v="${esc(s)}"` })).join('')}</div>
    </section>
    <section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Curated', title: 'Country spotlights' })}
      <div class="collection-grid">${countries.map(({ c, works }) => CollectionCard({ title: c.name, subtitle: `${works.length} works`, works, act: 'open-country', attrs: `data-v="${c.code}"` })).join('')}</div>
    </section>
  </div>`;
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
  const me = world.artistById.me;
  const allBadges = [...myBadges, ...(me ? world.badgesOf(me) : [])];
  const tasteTop = topStyles(state.taste, 5);
  const tasteTotal = tasteTop.reduce((s, k) => s + state.taste.styles[k], 0) || 1;
  const followed = Object.keys(state.follows).map((id) => world.artistById[id]).filter(Boolean);
  const myWorks = state.uploads.map((u) => world.artworkById[u.id]).filter(Boolean);
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

    ${state.user.role === 'artist' ? `<section class="section section-tight">
      ${SectionHeader({ eyebrow: 'Studio', title: 'Your work' })}
      <div class="profile-grid">
        <form id="upload" class="panel upload">
          <label class="dropzone dropzone-sm"><input type="file" name="file" accept="image/*" required>${Icon('plus', { size: 22 })}<b>Choose an image</b><small id="upload-name">Free to upload</small></label>
          <label class="field"><span>Title</span><input name="title" required maxlength="60"></label>
          <div class="field-row">
            <label class="field"><span>Medium</span><select name="category">${CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></label>
            <label class="field"><span>Movement</span><select name="style">${STYLES.map((s) => `<option>${s}</option>`).join('')}</select></label>
          </div>
          <label class="field"><span>Price (USD)</span><input name="price" type="number" min="10" step="10" required></label>
          <button class="btn btn-primary btn-block">Publish work</button>
        </form>
        <div class="panel">
          ${myWorks.length ? `<ol class="rank-list">${myWorks.map((w) => {
            const c = world.countsOf(w);
            const detail = canAnalyze ? ROLES.map((r) => `${r.label} ${c.likes[r.id] + c.saves[r.id]}`).join(' · ') : 'Who liked this · Pro';
            return `<li><button class="rank-row" data-act="artwork" data-id="${w.id}"><span class="rank-thumb">${ArtImage(w)}</span><span class="rank-text"><b>${esc(w.title)}</b><small>${detail}</small></span><span class="rank-score">${fmt(world.influence[w.id])}</span></button></li>`;
          }).join('')}</ol>` : EmptyState({ icon: 'grid', title: 'No works yet', body: 'Published works enter the rankings and Art Battles straight away.' })}
        </div>
      </div>
    </section>` : ''}

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
    $('input[type=file]', form).addEventListener('change', (e) => { $('#upload-name').textContent = e.target.files?.[0]?.name || 'Free to upload'; });
  }
}

async function onUpload(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const file = fd.get('file');
  if (!file || !file.size) return toast('Choose an image first.');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const category = fd.get('category');
    state.uploads.push({
      id: `u${Date.now()}`,
      title: String(fd.get('title')).trim().slice(0, 60),
      artistId: 'me',
      category,
      style: fd.get('style'),
      medium: categoryById[category].medium,
      year: CURRENT_YEAR,
      price: Math.max(10, Number(fd.get('price')) || 100),
      quality: 0.5,
      palette: PALETTES[0],
      image: canvas.toDataURL('image/jpeg', 0.82),
      counts: { likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } },
      elo: START_RATING,
      at: Date.now(),
    });
    commit();
    toast('Published. Your work is now in the rankings and battles.');
    renderView();
  } catch {
    toast('Could not read that image.');
  } finally {
    URL.revokeObjectURL(url);
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
      artworkIds: new Set(seed.artworks.map((w) => w.id)),
      artistIds: new Set(seed.artists.map((a) => a.id)),
    });
    imported = extra.reactions.filter((r) => r.kind !== 'pass').length + extra.follows.length;
    if (extra.reactions.length || extra.follows.length) {
      await cloud.importGuest(extra);
      mine = await cloud.mine();
    }
  }
  Object.assign(state, mineToState(mine));
  state.user = { ...state.user, name: profile.name, country: profile.country, role: profile.role };
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
  state.community = snapshotToCommunity(snap);
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
    ${PremiumButton('Sign out', { act: 'sign-out', variant: 'secondary' })}
  </section>`;
}

// ——— Actions ———
const ACTIONS = {
  swipe: (el) => decide(el.dataset.dir),
  react: (el) => react(world.artworkById[el.dataset.id], el.dataset.v),
  artwork: (el) => { closePopovers(); openSheet(() => artworkSheet(el.dataset.id), { wide: true }); },
  artist: (el) => { closePopovers(); openSheet(() => artistSheet(el.dataset.id), { wide: true }); },
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
  'chart-tab': (el) => { charts.tab = el.dataset.v; renderView(); },
  'chart-cat': (el) => { charts.category = el.dataset.v; renderView(); },
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
  'search-open': (el) => { closeSearch(); openSheet(() => (el.dataset.kind === 'artist' ? artistSheet : artworkSheet)(el.dataset.id), { wide: true }); },
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
