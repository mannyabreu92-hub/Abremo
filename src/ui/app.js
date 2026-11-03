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
import { artMarkup, artSVG } from './art.js';
import { loadState, saveState, resetState } from './store.js';

// ——— State ———
const seed = buildSeedWorld();
let state = loadState();
let world = createWorld(seed, state);
const rng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);

let deck = [];
let battlePair = null;
let battleLock = false;
const charts = { tab: 'artworks', scope: 'global', category: '' };
let sheetRenderer = null;
let lastScan = null;

function commit() {
  if (!saveState(state)) toast('Storage is full — some changes may not persist.');
  world = createWorld(seed, state);
}

// ——— Helpers ———
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const money = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const flag = (code) => countryByCode[code]?.flag || '🏳️';
const role = () => ROLES.find((r) => r.id === state.user.role);
const artistOf = (art) => world.artistById[art.artistId];
const initials = (name) => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const avatar = (artist, size = '') => {
  const p = PALETTES[artist.palette % PALETTES.length];
  return `<span class="avatar ${size}" style="background:linear-gradient(135deg,${p[1]},${p[3]})">${esc(initials(artist.name))}</span>`;
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function gain(text) {
  const g = document.createElement('div');
  g.className = 'gain';
  g.textContent = text;
  document.body.appendChild(g);
  setTimeout(() => g.remove(), 900);
}

function openSheet(renderer) {
  sheetRenderer = renderer;
  const sheet = $('#sheet');
  $('#sheet-body').innerHTML = renderer();
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
}

function closeSheet() {
  const sheet = $('#sheet');
  sheet.classList.remove('open');
  sheetRenderer = null;
  setTimeout(() => { if (!sheetRenderer) sheet.hidden = true; }, 220);
}

function refresh() {
  renderView();
  if (sheetRenderer) $('#sheet-body').innerHTML = sheetRenderer();
}

// ——— Router ———
const VIEWS = { discover: renderDiscover, battle: renderBattle, charts: renderCharts, scan: renderScan, profile: renderProfile };
const currentView = () => (VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'discover');

function renderView() {
  const name = currentView();
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  const r = role();
  $('#role-pill').innerHTML = `${r.emoji} ${r.label} <b>×${r.weight}</b>`;
  VIEWS[name]($('#view'));
}

// ——— Discover (swipe) ———
function fillDeck() {
  const seen = new Set([...Object.keys(state.interactions), ...deck.map((d) => d.artwork.id)]);
  const pool = world.artworks.filter((a) => a.artistId !== 'me');
  while (deck.length < 3) {
    const n = nextArtwork(pool, state.taste, rng, { seen, popularity: (a) => world.influence[a.id] });
    if (!n) break;
    deck.push(n);
    seen.add(n.artwork.id);
  }
}

function cardHTML({ artwork: w, reason }, top) {
  const a = artistOf(w);
  const following = !!state.follows[a.id];
  return `<article class="card${top ? ' top' : ''}" data-id="${w.id}">
    <div class="card-art">${artMarkup(w)}</div>
    <div class="stamp like">LIKE</div><div class="stamp nope">PASS</div><div class="stamp super">COLLECT</div>
    <div class="card-info">
      <span class="reason">${esc(reason)}</span>
      <h2>${esc(w.title)}</h2>
      <div class="byline">
        <button class="link" data-act="artist" data-id="${a.id}">${flag(a.country)} ${esc(a.name)}</button>
        <button class="follow${following ? ' on' : ''}" data-act="follow" data-id="${a.id}">${following ? 'Following' : '+ Follow'}</button>
      </div>
      <div class="chips"><span>${categoryById[w.category].emoji} ${esc(categoryById[w.category].label)}</span><span>${esc(w.style)}</span><span>${w.year}</span></div>
      <div class="card-meta">
        <span title="Weighted Influence Score">⚡ ${fmt(world.influence[w.id])} influence</span>
        <button class="info" data-act="artwork" data-id="${w.id}" aria-label="Artwork details">Details</button>
      </div>
    </div>
  </article>`;
}

function renderDiscover(root) {
  fillDeck();
  const top = deck[0];
  const isCritic = state.user.role === 'critic';
  root.innerHTML = `<section class="discover">
    <div class="deck" id="deck">
      ${deck.length ? deck.slice(0, 2).reverse().map((d, i, arr) => cardHTML(d, i === arr.length - 1)).join('') : `
        <div class="empty"><h2>You've seen it all ✨</h2><p>You've swiped through every artwork in the demo catalog.</p><button class="btn" data-act="reset-swipes">Start over</button></div>`}
    </div>
    <div class="actions" ${top ? '' : 'hidden'}>
      <button class="round pass" data-act="swipe" data-dir="pass" aria-label="Pass">✕</button>
      <button class="round super" data-act="swipe" data-dir="super" aria-label="Super like: collect">★</button>
      <button class="round like" data-act="swipe" data-dir="like" aria-label="Like">♥</button>
      ${isCritic ? `<button class="round review" data-act="review" data-id="${top?.artwork.id}" aria-label="Write a review">✍︎</button>` : ''}
      <button class="round buy" data-act="buy" data-id="${top?.artwork.id}" aria-label="Buy">$</button>
    </div>
    <p class="hint">→ like · ← pass · ↑ collect · your ${role().label.toLowerCase()} vote counts ×${role().weight}</p>
  </section>`;
  const card = $('.card.top', root);
  if (card) attachDrag(card);
}

function attachDrag(card) {
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
  const stamps = { like: $('.stamp.like', card), nope: $('.stamp.nope', card), super: $('.stamp.super', card) };
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true; sx = e.clientX; sy = e.clientY; dx = dy = 0;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
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
    card.style.transition = 'transform .25s ease';
    card.style.transform = '';
    Object.values(stamps).forEach((s) => { s.style.opacity = 0; });
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

function decide(action) {
  const card = $('.card.top');
  const entry = deck[0];
  if (!card || !entry || card.dataset.leaving) return;
  card.dataset.leaving = '1';
  const out = { like: 'translate(140%, 0) rotate(24deg)', pass: 'translate(-140%, 0) rotate(-24deg)', super: 'translate(0, -140%)' }[action];
  $(`.stamp.${action === 'pass' ? 'nope' : action}`, card).style.opacity = 1;
  card.style.transition = 'transform .32s ease-in';
  card.style.transform = out;
  setTimeout(() => {
    applySwipe(entry.artwork, action);
    deck.shift();
    renderView();
  }, 280);
}

function ensureDelta(id) {
  return (state.deltas[id] ||= { likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } });
}

function applySwipe(art, action) {
  const r = state.user.role;
  state.interactions[art.id] = action;
  if (action === 'like') ensureDelta(art.id).likes[r]++;
  if (action === 'super') ensureDelta(art.id).saves[r]++;
  state.taste = updateTaste(state.taste, art, action);
  commit();
  if (action === 'like') gain(`+${ROLE_WEIGHTS[r]} ⚡`);
  if (action === 'super') { gain(`+${ROLE_WEIGHTS[r] * SAVE_MULTIPLIER} ⚡`); toast(`Collected “${art.title}”`); }
}

// ——— Artwork & artist sheets ———
function artworkSheet(id) {
  const w = world.artworkById[id];
  const a = artistOf(w);
  const counts = world.countsOf(w);
  const rows = influenceBreakdown(counts);
  const max = Math.max(1, ...rows.map((r) => r.points));
  const globalRank = world.topArtworks().find((r) => r.item.id === id)?.rank;
  const countryRank = world.topArtworks({ country: a.country }).find((r) => r.item.id === id)?.rank;
  const catRank = world.topArtworks({ category: w.category }).find((r) => r.item.id === id)?.rank;
  const done = state.interactions[id];
  const avg = counts.reviews.count ? (counts.reviews.ratingSum / counts.reviews.count).toFixed(1) : '—';
  const myReview = state.reviews.find((r) => r.artworkId === id);
  return `<div class="detail">
    <div class="detail-art">${artMarkup(w)}</div>
    <h2>${esc(w.title)}</h2>
    <button class="link" data-act="artist" data-id="${a.id}">${flag(a.country)} ${esc(a.name)}</button>
    <p class="muted">${esc(w.medium)} · ${w.year} · ${esc(w.style)}</p>
    <div class="ranks">
      <div><b>#${globalRank}</b><small>Global</small></div>
      <div><b>#${countryRank}</b><small>${flag(a.country)} Country</small></div>
      <div><b>#${catRank}</b><small>${esc(categoryById[w.category].label)}</small></div>
      <div><b>${Math.round(world.eloOf(w))}</b><small>Battle Elo</small></div>
    </div>
    <h3>Influence Score <span class="big">⚡ ${fmt(world.influence[id])}</span></h3>
    <div class="bars">${rows.map((r) => `<div class="bar-row"><span>${r.emoji} ${esc(r.label)}</span><div class="bar"><i style="width:${(r.points / max) * 100}%"></i></div><span class="num">${fmt(r.points)}</span></div>
      <div class="bar-sub">${r.role === 'review' ? `${r.likes} reviews · avg ★ ${avg}` : `${fmt(r.likes)} likes · ${fmt(r.saves)} collects · ×${ROLE_WEIGHTS[r.role]}`}</div>`).join('')}</div>
    <div class="sheet-actions">
      ${done ? `<span class="pill">${done === 'pass' ? 'Passed' : done === 'super' ? '★ In your collection' : '♥ Liked'}</span>` : `
        <button class="btn ghost" data-act="sheet-swipe" data-dir="like" data-id="${id}">♥ Like</button>
        <button class="btn ghost" data-act="sheet-swipe" data-dir="super" data-id="${id}">★ Collect</button>`}
      ${state.user.role === 'critic' && !myReview ? `<button class="btn ghost" data-act="review" data-id="${id}">✍︎ Review</button>` : ''}
      <button class="btn" data-act="buy" data-id="${id}">Buy · ${money(w.price)}</button>
    </div>
    ${myReview ? `<blockquote>Your review: ${'★'.repeat(myReview.rating)}${'☆'.repeat(5 - myReview.rating)} ${esc(myReview.text)}</blockquote>` : ''}
  </div>`;
}

function artistSheet(id) {
  const a = world.artistById[id];
  const works = world.topArtworks().filter((r) => r.item.artistId === id);
  const followers = world.followersOf(a);
  const following = !!state.follows[id];
  const badges = world.badgesOf(a);
  return `<div class="detail">
    <div class="artist-head">${avatar(a, 'xl')}<div>
      <h2>${esc(a.name)}</h2>
      <p class="muted">${flag(a.country)} ${esc(countryByCode[a.country]?.name || '')} · ${esc(categoryById[a.category]?.label || '')} · since ${a.debutYear}</p>
      <p class="muted">${a.styles.map(esc).join(' · ')}</p>
    </div></div>
    ${badges.length ? `<div class="badges">${badges.map((b) => `<span class="badge" title="${esc(BADGES[b].desc)}">${BADGES[b].emoji} ${BADGES[b].label}</span>`).join('')}</div>` : ''}
    <div class="ranks">
      <div><b>${fmt(world.artistScores[id])}</b><small>Artist score</small></div>
      <div><b>#${world.globalArtistRanks[id]}</b><small>🌎 Global</small></div>
      <div><b>#${world.countryArtistRanks[id]}</b><small>${flag(a.country)} Country</small></div>
      <div><b>${fmt(Object.values(followers).reduce((s, n) => s + n, 0))}</b><small>Followers</small></div>
    </div>
    <p class="muted small">Followers: ${ROLES.map((r) => `${r.emoji} ${fmt(followers[r.id])}`).join(' · ')}</p>
    ${a.isMe ? '' : `<div class="sheet-actions">
      <button class="btn${following ? ' ghost' : ''}" data-act="follow" data-id="${id}">${following ? '✓ Following' : '+ Follow journey'}</button>
      ${state.user.role === 'collector' ? `<button class="btn ghost" data-act="sponsor" data-id="${id}">💎 Sponsor</button>` : ''}
      <button class="btn ghost" data-act="contact" data-id="${id}">✉︎ Contact</button>
    </div>`}
    <h3>Works</h3>
    <div class="grid">${works.map((r) => `<button class="tile" data-act="artwork" data-id="${r.item.id}">${artMarkup(r.item)}<span>#${r.rank} · ${esc(r.item.title)}</span></button>`).join('')}</div>
  </div>`;
}

function buySheet(id) {
  const w = world.artworkById[id];
  const a = artistOf(w);
  const b = checkoutBreakdown(w.price);
  const bought = state.purchases.some((p) => p.artworkId === id);
  return `<div class="detail">
    <div class="buy-head"><div class="thumb">${artMarkup(w)}</div><div><h2>${esc(w.title)}</h2><p class="muted">${flag(a.country)} ${esc(a.name)} · ${esc(w.medium)}</p></div></div>
    <table class="receipt">
      <tr><td>Artwork</td><td>${money(b.price)}</td></tr>
      <tr><td>Gabangi fee (${(b.rate * 100).toFixed(1).replace('.0', '')}%)</td><td>${money(b.fee)}</td></tr>
      <tr class="total"><td>Artist receives</td><td>${money(b.artistPayout)}</td></tr>
    </table>
    <p class="muted small">Commission slides from 10% to 5% as price rises. Buyers pay the listed price.</p>
    <div class="sheet-actions">${bought ? '<span class="pill">✓ Purchased</span>' : `<button class="btn" data-act="purchase" data-id="${id}">Buy now · ${money(w.price)}</button>`}</div>
    <h3>Or contact the artist directly</h3>
    <textarea id="msg" rows="3" placeholder="Hi ${esc(a.name.split(' ')[0])}, I love “${esc(w.title)}”…"></textarea>
    <div class="sheet-actions"><button class="btn ghost" data-act="send-message" data-id="${id}">Send message</button></div>
    <p class="muted small">Prototype: no payment is taken and no message leaves your device.</p>
  </div>`;
}

function contactSheet(artistId) {
  const a = world.artistById[artistId];
  return `<div class="detail"><h2>Message ${esc(a.name)}</h2>
    <textarea id="msg" rows="4" placeholder="Commission request, studio visit, collaboration…"></textarea>
    <div class="sheet-actions"><button class="btn" data-act="send-message" data-artist="${artistId}">Send</button></div>
    <p class="muted small">Prototype: messages are stored on this device only.</p></div>`;
}

function reviewSheet(id) {
  const w = world.artworkById[id];
  return `<div class="detail"><h2>Review “${esc(w.title)}”</h2>
    <p class="muted">A 5★ critic review is worth ${ROLE_WEIGHTS.critic * 2} influence — twice a critic like.</p>
    <div class="stars" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-act="star" data-n="${n}" aria-label="${n} stars">★</button>`).join('')}</div>
    <textarea id="review-text" rows="4" placeholder="What makes this work matter?"></textarea>
    <div class="sheet-actions"><button class="btn" data-act="submit-review" data-id="${id}">Publish review</button></div></div>`;
}

// ——— Battle ———
function newBattle() {
  const pool = world.artworks.filter((a) => a.artistId !== 'me');
  battlePair = pickBattlePair(pool, rng);
  battleLock = false;
}

function battleCard(w, i) {
  const a = artistOf(w);
  return `<button class="battle-card" data-act="vote" data-i="${i}">
    <div class="battle-art">${artMarkup(w)}</div>
    <div class="battle-meta"><b>${esc(w.title)}</b><small>${flag(a.country)} ${esc(a.name)}</small><small class="elo">Elo ${Math.round(world.eloOf(w))}</small></div>
    <div class="battle-result"></div>
  </button>`;
}

function renderBattle(root) {
  if (!battlePair) newBattle();
  const [l, r] = battlePair;
  root.innerHTML = `<section class="battle">
    <header class="view-head"><h1>Art Battle</h1><p>Which one moves you? Tap to vote.</p>
      <div class="battle-stats"><span>🗳 ${state.battles.voted} votes</span><span>🔥 Crowd streak ${state.battles.streak}</span><span>Your vote: K=${kFactor(state.user.role)}</span></div>
    </header>
    <div class="arena">${battleCard(l, 0)}<span class="vs">VS</span>${battleCard(r, 1)}</div>
    <p class="hint">← / → to vote · winners gain Elo, losers drop only ${LOSS_FACTOR * 100}% as much</p>
  </section>`;
}

function vote(i) {
  if (battleLock || !battlePair) return;
  battleLock = true;
  const winner = battlePair[i], loser = battlePair[1 - i];
  const wr = world.eloOf(winner), lr = world.eloOf(loser);
  const res = battleResult(wr, lr, state.user.role);
  const crowd = Math.round(expectedScore(wr, lr) * 100);
  state.elo[winner.id] = res.winner;
  state.elo[loser.id] = res.loser;
  state.battles.voted++;
  state.battles.streak = crowd >= 50 ? state.battles.streak + 1 : 0;
  commit();
  const cards = document.querySelectorAll('.battle-card');
  cards[i].classList.add('won');
  cards[1 - i].classList.add('lost');
  $('.battle-result', cards[i]).innerHTML = `<b>+${res.gain}</b><small>${crowd}% agree</small>`;
  $('.battle-result', cards[1 - i]).innerHTML = `<b>−${res.loss}</b><small>${100 - crowd}%</small>`;
  if (res.upset) toast('Upset! The underdog won.');
  setTimeout(() => {
    newBattle();
    if (currentView() === 'battle') renderView();
  }, 1300);
}

// ——— Charts ———
function chartSnapshot() {
  const current = {
    art: rankMap(world.topArtworks()),
    artist: rankMap(world.topArtists()),
  };
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

function moveBadge(delta) {
  if (delta === null) return '<span class="move new">NEW</span>';
  if (delta > 0) return `<span class="move up">▲${delta}</span>`;
  if (delta < 0) return `<span class="move down">▼${-delta}</span>`;
  return '<span class="move same">–</span>';
}

function renderCharts(root) {
  const previous = chartSnapshot();
  const country = charts.scope === 'global' ? null : charts.scope;
  const opts = { country, category: charts.category || null };
  const showMove = !country && !charts.category && charts.tab !== 'elo';
  const place = country ? `${flag(country)} ${countryByCode[country].name}` : '🌎 Worldwide';
  const titles = { artworks: 'Top Artworks', artists: 'Top Artists', elo: 'Battle Champions' };
  const now = new Date();
  now.setMinutes(0, 0, 0);

  let rows = '';
  if (charts.tab === 'artists') {
    rows = world.topArtists(opts).slice(0, 50).map((r) => {
      const a = r.item;
      const badges = world.badgesOf(a).map((b) => BADGES[b].emoji).join('');
      return `<li class="row${r.rank <= 3 ? ' podium' : ''}" data-act="artist" data-id="${a.id}">
        <span class="rank">${r.rank}</span>${showMove ? moveBadge(movement(a.id, r.rank, previous?.artist)) : ''}
        ${avatar(a)}<div class="meta"><b>${esc(a.name)} ${a.isMe ? '<em>(you)</em>' : ''}</b><small>${flag(a.country)} ${esc(categoryById[a.category]?.label || '')} ${badges}</small></div>
        <span class="score">${fmt(r.score)}</span></li>`;
    }).join('');
  } else {
    const list = charts.tab === 'elo' ? world.topElo(opts) : world.topArtworks(opts);
    rows = list.slice(0, 50).map((r) => {
      const w = r.item, a = artistOf(w);
      return `<li class="row${r.rank <= 3 ? ' podium' : ''}" data-act="artwork" data-id="${w.id}">
        <span class="rank">${r.rank}</span>${showMove ? moveBadge(movement(w.id, r.rank, previous?.art)) : ''}
        <div class="thumb">${artMarkup(w)}</div><div class="meta"><b>${esc(w.title)}</b><small>${flag(a.country)} ${esc(a.name)} · ${esc(categoryById[w.category].label)}</small></div>
        <span class="score">${charts.tab === 'elo' ? Math.round(r.score) : `⚡${fmt(r.score)}`}</span></li>`;
    }).join('');
  }

  root.innerHTML = `<section class="charts">
    <header class="view-head"><h1>${titles[charts.tab]}</h1>
      <p>${place}${charts.category ? ` · ${esc(categoryById[charts.category].label)}` : ''} · Updated hourly · last refresh ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p></header>
    <div class="seg">${Object.entries({ artworks: 'Artworks', artists: 'Artists', elo: 'Battles' }).map(([k, v]) => `<button class="${charts.tab === k ? 'on' : ''}" data-act="chart-tab" data-v="${k}">${v}</button>`).join('')}</div>
    <div class="filters">
      <select id="scope" aria-label="Region">
        <option value="global">🌎 Global</option>
        ${COUNTRIES.map((c) => `<option value="${c.code}" ${charts.scope === c.code ? 'selected' : ''}>${c.flag} ${c.name}${c.code === state.user.country ? ' (you)' : ''}</option>`).join('')}
      </select>
      <div class="chips scroll">
        <button class="${!charts.category ? 'on' : ''}" data-act="chart-cat" data-v="">All</button>
        ${CATEGORIES.map((c) => `<button class="${charts.category === c.id ? 'on' : ''}" data-act="chart-cat" data-v="${c.id}">${c.emoji} ${esc(c.label)}</button>`).join('')}
      </div>
    </div>
    <ol class="list">${rows || '<li class="muted">Nothing here yet.</li>'}</ol>
    <p class="muted small explainer">Influence = Σ likes × role weight (Fan 1 · Artist 3 · Critic 5 · Collector 9), collects count ×${SAVE_MULTIPLIER}, critic reviews up to ${ROLE_WEIGHTS.critic * 2} each. Weighting makes fake popularity expensive.</p>
  </section>`;
  $('#scope', root).addEventListener('change', (e) => { charts.scope = e.target.value; renderView(); });
}

// ——— Scan (AI recognition) ———
function renderScan(root) {
  root.innerHTML = `<section class="scan">
    <header class="view-head"><h1>Scan art</h1><p>Snap any artwork — in a gallery, on a wall, on a screen. Gabangi identifies the style, medium and similar artists.</p></header>
    <label class="drop"><input type="file" id="scan-file" accept="image/*" capture="environment"><span>📷 Take or upload a photo</span></label>
    <button class="btn ghost wide" data-act="scan-sample">Try it on a random artwork</button>
    <div id="scan-result">${lastScan ? scanResultHTML(lastScan) : ''}</div>
  </section>`;
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
    const works = world.topArtworks().map((r) => r.item).filter((x) => x.style === styles[0].name).slice(0, 6);
    lastScan = { preview: canvas.toDataURL('image/jpeg', 0.8), label, features, styles, medium, artists, works };
    if (currentView() === 'scan') $('#scan-result').innerHTML = scanResultHTML(lastScan);
  } catch {
    toast('Could not read that image.');
  }
}

function scanResultHTML(s) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  return `<div class="scan-card">
    <img src="${s.preview}" alt="Scanned image">
    <div><h3>Looks like <span class="accent">${esc(s.styles[0].name)}</span></h3><p class="muted">${esc(s.medium.label)}${s.label ? ` · ${esc(s.label)}` : ''}</p></div>
  </div>
  <div class="bars">${s.styles.slice(0, 4).map((x) => `<div class="bar-row"><span>${esc(x.name)}</span><div class="bar"><i style="width:${pct(x.confidence)}"></i></div><span class="num">${pct(x.confidence)}</span></div>`).join('')}</div>
  <p class="muted small">Signals · brightness ${pct(s.features.brightness)} · saturation ${pct(s.features.saturation)} · texture ${pct(s.features.edgeDensity)} · hue variety ${pct(s.features.hueVariety)}</p>
  <h3>Similar artists</h3>
  <ul class="list compact">${s.artists.map(({ artist: a }) => `<li class="row" data-act="artist" data-id="${a.id}">${avatar(a)}<div class="meta"><b>${esc(a.name)}</b><small>${flag(a.country)} ${a.styles.map(esc).join(' · ')}</small></div><span class="score">${fmt(world.artistScores[a.id])}</span></li>`).join('')}</ul>
  <h3>More ${esc(s.styles[0].name)}</h3>
  <div class="grid">${s.works.map((w) => `<button class="tile" data-act="artwork" data-id="${w.id}">${artMarkup(w)}<span>${esc(w.title)}</span></button>`).join('')}</div>
  <p class="muted small">Prototype runs on-device from pixel statistics. Production swaps in a vision model behind the same interface.</p>`;
}

async function scanSample() {
  const pool = world.artworks.filter((a) => !a.image);
  const w = pool[Math.floor(rng() * pool.length)];
  const blob = new Blob([artSVG(w)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  await runScan(url, `Sample: “${w.title}” (${w.style})`);
  URL.revokeObjectURL(url);
}

// ——— Profile ———
function renderProfile(root) {
  const liked = Object.entries(state.interactions).filter(([, v]) => v === 'like').map(([k]) => k);
  const collected = Object.entries(state.interactions).filter(([, v]) => v === 'super').map(([k]) => k).filter((id) => world.artworkById[id]);
  const top20 = new Set(world.topArtworks().slice(0, BADGE_RULES.trendSetterTopN).map((r) => r.item.id));
  const trendHits = [...liked, ...collected].filter((id) => top20.has(id)).length;
  const myBadges = userBadges({ role: state.user.role, collectedCount: collected.length + state.purchases.length, reviewCount: state.reviews.length, trendHits });
  const me = world.artistById.me;
  const artistBadgeList = me ? world.badgesOf(me) : [];
  const allBadges = [...myBadges, ...artistBadgeList];
  const tasteTop = topStyles(state.taste, 5);
  const tasteTotal = tasteTop.reduce((s, k) => s + state.taste.styles[k], 0) || 1;
  const followed = Object.keys(state.follows).map((id) => world.artistById[id]).filter(Boolean);
  const myWorks = state.uploads.map((u) => world.artworkById[u.id]).filter(Boolean);
  const canAnalyze = hasFeature(state.user.plan, 'whoLiked');

  root.innerHTML = `<section class="profile">
    <header class="profile-head">
      <span class="avatar xl me">${esc(initials(state.user.name || 'You'))}</span>
      <div class="profile-fields">
        <input id="name" value="${esc(state.user.name)}" aria-label="Display name" maxlength="40">
        <select id="country" aria-label="Country">${COUNTRIES.map((c) => `<option value="${c.code}" ${c.code === state.user.country ? 'selected' : ''}>${c.flag} ${c.name}</option>`).join('')}</select>
      </div>
    </header>

    <div class="stats">
      <div><b>${liked.length}</b><small>Liked</small></div>
      <div><b>${collected.length}</b><small>Collected</small></div>
      <div><b>${followed.length}</b><small>Following</small></div>
      <div><b>${state.battles.voted}</b><small>Battles</small></div>
      <div><b>${state.reviews.length}</b><small>Reviews</small></div>
      <div><b>${state.purchases.length}</b><small>Bought</small></div>
    </div>

    <h3>Badges</h3>
    <div class="badges">${allBadges.length ? allBadges.map((b) => `<span class="badge" title="${esc(BADGES[b].desc)}">${BADGES[b].emoji} ${BADGES[b].label}</span>`).join('') : '<span class="muted small">None yet.</span>'}</div>
    <details class="badge-guide"><summary>How to earn badges</summary>${Object.values(BADGES).map((b) => `<p><b>${b.emoji} ${b.label}</b> — ${esc(b.desc)}</p>`).join('')}</details>

    <h3>Your role</h3>
    <div class="roles">${ROLES.map((r) => `<button class="role-card${r.id === state.user.role ? ' on' : ''}" data-act="set-role" data-v="${r.id}">
      <span class="role-emoji">${r.emoji}</span><b>${r.label}</b><span class="weight">${r.weight} pt${r.weight > 1 ? 's' : ''}</span><small>${esc(r.blurb)}</small></button>`).join('')}</div>
    <p class="muted small">Demo: switch freely. In production, Critic and Collector status requires verification.</p>

    <h3>Your taste</h3>
    ${tasteTop.length ? `<div class="bars">${tasteTop.map((k) => `<div class="bar-row"><span>${esc(k)}</span><div class="bar"><i style="width:${(state.taste.styles[k] / tasteTotal) * 100}%"></i></div><span class="num">${Math.round((state.taste.styles[k] / tasteTotal) * 100)}%</span></div>`).join('')}</div>
      <p class="muted small">About ${Math.round(EXPLOIT_RATIO * 100)}% of your feed now comes from these styles; the rest keeps exploring.</p>` : '<p class="muted small">Swipe a few artworks and your feed starts learning.</p>'}

    <h3>Collection</h3>
    ${collected.length ? `<div class="grid">${collected.map((id) => world.artworkById[id]).map((w) => `<button class="tile" data-act="artwork" data-id="${w.id}">${artMarkup(w)}<span>${esc(w.title)}</span></button>`).join('')}</div>` : '<p class="muted small">Swipe up or tap ★ to collect.</p>'}

    <h3>Following</h3>
    ${followed.length ? `<ul class="list compact">${followed.map((a) => `<li class="row" data-act="artist" data-id="${a.id}">${avatar(a)}<div class="meta"><b>${esc(a.name)}</b><small>${flag(a.country)} #${world.globalArtistRanks[a.id]} global</small></div></li>`).join('')}</ul>` : '<p class="muted small">Follow artists to subscribe to their journey.</p>'}

    ${state.user.role === 'artist' ? `<h3>Artist studio</h3>
      <form id="upload" class="upload">
        <label class="drop small"><input type="file" name="file" accept="image/*" required><span>🖼 Choose an image</span></label>
        <input name="title" placeholder="Title" required maxlength="60">
        <div class="row2"><select name="category">${CATEGORIES.map((c) => `<option value="${c.id}">${c.emoji} ${esc(c.label)}</option>`).join('')}</select>
        <select name="style">${STYLES.map((s) => `<option>${s}</option>`).join('')}</select></div>
        <input name="price" type="number" min="10" step="10" placeholder="Price (USD)" required>
        <button class="btn wide">Upload — free</button>
      </form>
      ${myWorks.length ? `<ul class="list compact">${myWorks.map((w) => {
        const c = world.countsOf(w);
        const detail = canAnalyze ? `<small>${ROLES.map((r) => `${r.emoji} ${c.likes[r.id] + c.saves[r.id]}`).join(' · ')}</small>` : '<small>🔒 Who liked this — Pro</small>';
        return `<li class="row" data-act="artwork" data-id="${w.id}"><div class="thumb">${artMarkup(w)}</div><div class="meta"><b>${esc(w.title)}</b>${detail}</div><span class="score">⚡${fmt(world.influence[w.id])}</span></li>`;
      }).join('')}</ul>` : ''}` : ''}

    <h3>Plans</h3>
    <div class="plans">${PLANS.map((p) => `<div class="plan${p.id === state.user.plan ? ' on' : ''}"><b>${p.name}</b><span class="price">${p.price ? `${money(p.price)}<small>/mo</small>` : 'Free'}</span>
      <ul>${p.features.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${p.id === state.user.plan ? '<span class="pill">Current</span>' : `<button class="btn ghost" data-act="set-plan" data-v="${p.id}">Choose</button>`}</div>`).join('')}</div>
    <p class="muted small">No charge for artists to start. Gabangi earns from Pro subscriptions and a 5–10% marketplace commission.</p>

    <div class="sheet-actions"><button class="btn ghost" data-act="about">About Gabangi</button><button class="btn ghost danger" data-act="reset">Reset demo data</button></div>
  </section>`;

  $('#name', root).addEventListener('change', (e) => { state.user.name = e.target.value.trim() || 'You'; commit(); renderView(); });
  $('#country', root).addEventListener('change', (e) => { state.user.country = e.target.value; commit(); toast(`You're now on the ${countryByCode[e.target.value].name} leaderboard`); renderView(); });
  const form = $('#upload', root);
  if (form) form.addEventListener('submit', onUpload);
}

async function onUpload(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const file = fd.get('file');
  if (!file || !file.size) return toast('Choose an image first.');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, 720 / Math.max(img.naturalWidth, img.naturalHeight));
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
      image: canvas.toDataURL('image/jpeg', 0.8),
      counts: { likes: emptyRoleCounts(), saves: emptyRoleCounts(), reviews: { count: 0, ratingSum: 0 } },
      elo: START_RATING,
    });
    commit();
    toast('Uploaded — your work is now in the charts and battles.');
    renderView();
  } catch {
    toast('Could not read that image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function aboutSheet() {
  return `<div class="detail about">
    <h2>Gabangi</h2><p class="accent">The Tinder and TikTok of Art.</p>
    <p>People don't wake up saying “I want to upload art.” They wake up saying <b>“Show me something amazing.”</b> Gabangi makes finding art addictive: swipe through paintings, photography, sculpture, street art, NFTs and AI art, discover emerging artists, and watch your taste move the charts.</p>
    <h3>Why weighted influence</h3>
    <p>100 fan likes (100) + 20 artist likes (60) + 10 critic likes (50) + 5 collector likes (45) = <b>255 influence</b>. Buying fake likes from throwaway accounts barely moves a chart that collectors and critics shape.</p>
    <h3>Artwork first</h3>
    <p>People fall in love with a painting before they fall in love with the painter, so the default chart ranks artworks, not artists.</p>
  </div>`;
}

// ——— Actions ———
const ACTIONS = {
  swipe: (el) => decide(el.dataset.dir),
  'sheet-swipe': (el) => {
    const w = world.artworkById[el.dataset.id];
    applySwipe(w, el.dataset.dir);
    deck = deck.filter((d) => d.artwork.id !== w.id);
    refresh();
  },
  artwork: (el) => openSheet(() => artworkSheet(el.dataset.id)),
  artist: (el) => openSheet(() => artistSheet(el.dataset.id)),
  buy: (el) => el.dataset.id && el.dataset.id !== 'undefined' && openSheet(() => buySheet(el.dataset.id)),
  contact: (el) => openSheet(() => contactSheet(el.dataset.id)),
  review: (el) => {
    const id = el.dataset.id;
    if (state.reviews.some((r) => r.artworkId === id)) return toast('You already reviewed this work.');
    openSheet(() => reviewSheet(id));
  },
  star: (el) => {
    const n = Number(el.dataset.n);
    $('#stars').dataset.rating = n;
    document.querySelectorAll('#stars button').forEach((b, i) => b.classList.toggle('on', i < n));
  },
  'submit-review': (el) => {
    const id = el.dataset.id;
    const rating = Number($('#stars').dataset.rating || 0);
    if (!rating) return toast('Pick a star rating first.');
    const text = $('#review-text').value.trim().slice(0, 500);
    state.reviews.push({ artworkId: id, rating, text, at: Date.now() });
    const d = ensureDelta(id);
    d.reviews.count++;
    d.reviews.ratingSum += rating;
    state.taste = updateTaste(state.taste, world.artworkById[id], 'review');
    commit();
    gain(`+${ROLE_WEIGHTS.critic * 2 * (rating / 5)} ⚡`);
    openSheet(() => artworkSheet(id));
    renderView();
  },
  follow: (el) => {
    const id = el.dataset.id;
    if (state.follows[id]) delete state.follows[id];
    else {
      state.follows[id] = state.user.role;
      state.taste = { ...state.taste, artists: { ...state.taste.artists, [id]: (state.taste.artists[id] || 0) + 1.5 } };
      toast(`Following ${world.artistById[id].name}`);
    }
    commit();
    refresh();
  },
  sponsor: (el) => {
    state.messages.push({ artistId: el.dataset.id, text: '[sponsorship request]', at: Date.now() });
    commit();
    toast(`Sponsorship request sent to ${world.artistById[el.dataset.id].name}`);
  },
  'send-message': (el) => {
    const text = $('#msg').value.trim();
    if (!text) return toast('Write a message first.');
    const artistId = el.dataset.artist || world.artworkById[el.dataset.id].artistId;
    state.messages.push({ artistId, artworkId: el.dataset.id || null, text: text.slice(0, 1000), at: Date.now() });
    commit();
    toast(`Message sent to ${world.artistById[artistId].name}`);
    closeSheet();
  },
  purchase: (el) => {
    const w = world.artworkById[el.dataset.id];
    const b = checkoutBreakdown(w.price);
    state.purchases.push({ artworkId: w.id, price: b.price, fee: b.fee, at: Date.now() });
    if (state.interactions[w.id] !== 'super') {
      state.interactions[w.id] = 'super';
      ensureDelta(w.id).saves[state.user.role]++;
      deck = deck.filter((d) => d.artwork.id !== w.id);
    }
    commit();
    toast(`You own “${w.title}” 🎉`);
    refresh();
  },
  vote: (el) => vote(Number(el.dataset.i)),
  'chart-tab': (el) => { charts.tab = el.dataset.v; renderView(); },
  'chart-cat': (el) => { charts.category = el.dataset.v; renderView(); },
  'set-role': (el) => {
    state.user.role = el.dataset.v;
    commit();
    toast(`You're a ${role().label} now — your votes count ×${role().weight}`);
    renderView();
  },
  'set-plan': (el) => { state.user.plan = el.dataset.v; commit(); toast(`Switched to ${PLANS.find((p) => p.id === el.dataset.v).name} (demo — no charge)`); renderView(); },
  'scan-sample': () => scanSample(),
  about: () => openSheet(aboutSheet),
  'reset-swipes': () => { state.interactions = {}; deck = []; commit(); renderView(); },
  reset: () => {
    if (!confirm('Reset all demo data on this device?')) return;
    state = resetState();
    deck = []; battlePair = null; lastScan = null;
    world = createWorld(seed, state);
    renderView();
  },
  'close-sheet': () => closeSheet(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape' && sheetRenderer) return closeSheet();
  if (sheetRenderer) return;
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

window.addEventListener('hashchange', () => { closeSheet(); renderView(); window.scrollTo(0, 0); });
renderView();
