// Reusable view components. Each returns an HTML string; behaviour is wired through the
// delegated `data-act` actions in app.js, so components stay pure and composable.

import { artSVG } from './art.js';
import { categoryById, countryByCode, PALETTES } from '../core/seed.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
export const money = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export const flag = (code) => countryByCode[code]?.flag || '';
export const countryName = (code) => countryByCode[code]?.name || '';
export const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

// ——— Icons (1.5px stroke, 24 grid) ———
const P = {
  heart: '<path d="M12 20.5s-7.5-4.6-9.2-9.4A4.9 4.9 0 0 1 12 6.6a4.9 4.9 0 0 1 9.2 4.5C19.5 15.9 12 20.5 12 20.5z"/>',
  bookmark: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  swords: '<path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5L18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2"/>',
  trophy: '<path d="M8 20.5h8M12 16.5v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1.5a3 3 0 0 0 3 3M17 6h3v1.5a3 3 0 0 1-3 3"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.4l-5.1 2.8 1.1-5.6-4.2-3.9 5.7-.7z"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  collection: '<rect x="3.5" y="7" width="13" height="13" rx="2"/><path d="M7 4h11.5A2 2 0 0 1 20.5 6v11.5"/>',
  pen: '<path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4M7 10.5H6a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1"/>',
  plusSquare: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  bars: '<path d="M6 20V11M12 20V5M18 20v-6M3.5 20.5h17"/>',
  crown: '<path d="M4 8l4 4 4-7 4 7 4-4-1.5 10h-13zM5.5 20.5h13"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.6 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.6-3.6-8.5S9.4 6.1 12 3.5z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="12" cy="5.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="18.5" r="1.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  folderPlus: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/><path d="M12 11v6M9 14h6"/>',
};

/** The ABREMI symbol: a geometric A (solid left stroke, fine right stroke, offset crossbar). Flat, no gradient. */
export const ABREMI_SYMBOL_PATHS = '<path d="M15.3 3.2 3.6 28.8h6.2L17.9 9.6z"/><path d="M16.4 3.2h2.1l10 25.6h-2.2z"/><path d="M10.6 20.3h13.4l.6 1.7H10z"/>';

export function AbremiSymbol(size = 28, label = '') {
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="abremi-symbol" width="${size}" height="${size}" viewBox="0 0 32 32" fill="currentColor" ${a11y}>${ABREMI_SYMBOL_PATHS}</svg>`;
}

export function AbremiLogo({ size = 26 } = {}) {
  return `<span class="abremi-logo">${AbremiSymbol(size)}<span class="brand-word">Abremi</span></span>`;
}

export function Icon(name, { size = 20, label } = {}) {
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" ${a11y}>${P[name] || ''}</svg>`;
}

// ——— Images ———
const uriCache = new Map();
/** Artwork as an <img>: lazy, async-decoded, never distorted. Uploaded photos are letterboxed, not cropped. */
/**
 * Artwork as an <img>: lazy, async-decoded, never distorted. Uploaded photos are letterboxed, not cropped.
 * Grids get the small thumbnail; large views (eager or full) get the full image.
 */
export function ArtImage(art, { eager = false, full = false, className = '' } = {}) {
  let src = (eager || full ? art.image : art.thumb || art.image) || '';
  if (!src) {
    if (!uriCache.has(art.id)) uriCache.set(art.id, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artSVG(art))}`);
    src = uriCache.get(art.id);
  }
  const remote = /^https?:/.test(src);
  const size = art.width && art.height ? ` width="${art.width}" height="${art.height}"` : '';
  const cls = `art-img${art.image ? ' is-photo' : ''}${className ? ` ${className}` : ''}`;
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(art.title)}"${size}${remote ? ' crossorigin="anonymous"' : ''} ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" draggable="false">`;
}

export function Avatar(artist, size = 'md') {
  if (!artist) return '';
  const p = PALETTES[(artist.palette || 0) % PALETTES.length];
  return `<span class="avatar avatar-${size}" style="--a1:${p[1]};--a2:${p[3]}" aria-hidden="true">${esc(initials(artist.name))}</span>`;
}

// ——— Buttons ———
export function PremiumButton(label, { act, variant = 'primary', icon, attrs = '', size = '' } = {}) {
  return `<button class="btn btn-${variant}${size ? ` btn-${size}` : ''}" ${act ? `data-act="${act}"` : ''} ${attrs}>${icon ? Icon(icon, { size: 18 }) : ''}<span>${label}</span></button>`;
}

export function IconButton(icon, label, { act, attrs = '', className = '' } = {}) {
  return `<button class="icon-btn ${className}" ${act ? `data-act="${act}"` : ''} aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${Icon(icon)}</button>`;
}

// ——— Artwork ———
/**
 * ctx: { artist, reaction: 'like'|'super'|'pass'|undefined, rank, score, meta }
 */
export function ArtworkCard(art, ctx = {}) {
  const { artist, reaction, rank, score, eager, details } = ctx;
  const cat = categoryById[art.category];
  const liked = reaction === 'like' || reaction === 'super';
  const saved = reaction === 'super';
  return `<article class="art-card">
    <button class="art-frame" data-act="artwork" data-id="${art.id}" aria-label="View ${esc(art.title)}">
      ${ArtImage(art, { eager })}
      ${rank ? `<span class="rank-tag">No. ${rank}</span>` : ''}
    </button>
    <div class="art-quick">
      <button class="quick-btn${liked ? ' is-on' : ''}" data-act="react" data-v="like" data-id="${art.id}" aria-pressed="${liked}" aria-label="${liked ? 'Unlike' : 'Like'} ${esc(art.title)}">${Icon('heart', { size: 18 })}</button>
      <button class="quick-btn${saved ? ' is-on' : ''}" data-act="react" data-v="super" data-id="${art.id}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from collection' : 'Save to collection'}">${Icon('bookmark', { size: 18 })}</button>
    </div>
    <div class="art-caption">
      <div class="art-caption-main">
        <h3 class="art-title"><button data-act="artwork" data-id="${art.id}">${esc(art.title)}</button></h3>
        ${artist ? `<button class="art-artist" data-act="artist" data-id="${artist.id}">${esc(artist.name)}</button>` : ''}
        <p class="art-meta">${details ? `${esc(art.medium || cat?.label || '')}${art.year ? ` · ${art.year}` : ''}` : `${esc(cat?.label || '')}${art.year ? `, ${art.year}` : ''}`}</p>
        ${details && art.price ? `<p class="art-price">${money(art.price)}</p>` : ''}
      </div>
      ${score != null ? `<span class="art-score">${score}</span>` : ''}
    </div>
  </article>`;
}

export function ArtworkGrid(items, { className = '' } = {}) {
  return `<div class="art-grid ${className}">${items.join('')}</div>`;
}

export function FeaturedArtwork(art, { artist, label, reaction, influence, actionsHTML = '' }) {
  const cat = categoryById[art.category];
  return `<section class="featured">
    <button class="featured-frame" data-act="artwork" data-id="${art.id}" aria-label="View ${esc(art.title)}">${ArtImage(art, { eager: true })}</button>
    <div class="featured-body">
      ${label ? `<p class="eyebrow">${label}</p>` : ''}
      <h2 class="display-md">${esc(art.title)}</h2>
      <button class="artist-line" data-act="artist" data-id="${artist.id}">${Avatar(artist, 'sm')}<span><b>${esc(artist.name)}</b><small>${esc(countryName(artist.country))}</small></span></button>
      <dl class="spec">
        <div><dt>Medium</dt><dd>${esc(art.medium)}</dd></div>
        <div><dt>Year</dt><dd>${art.year}</dd></div>
        <div><dt>Movement</dt><dd>${esc(art.style)}</dd></div>
        <div><dt>Category</dt><dd>${esc(cat?.label || '')}</dd></div>
        ${influence != null ? `<div><dt>Influence</dt><dd>${fmt(influence)}</dd></div>` : ''}
        <div><dt>Price</dt><dd>${money(art.price)}</dd></div>
      </dl>
      <div class="featured-actions">
        <button class="btn btn-icon${reaction === 'like' || reaction === 'super' ? ' is-on' : ''}" data-act="react" data-v="like" data-id="${art.id}" aria-label="Like">${Icon('heart', { size: 18 })}</button>
        <button class="btn btn-icon${reaction === 'super' ? ' is-on' : ''}" data-act="react" data-v="super" data-id="${art.id}" aria-label="Save to collection">${Icon('bookmark', { size: 18 })}</button>
        ${PremiumButton('View work', { act: 'artwork', variant: 'secondary', attrs: `data-id="${art.id}"` })}
        ${PremiumButton('Inquire', { act: 'buy', variant: 'primary', attrs: `data-id="${art.id}"` })}
        ${actionsHTML}
      </div>
    </div>
  </section>`;
}

// ——— Artists ———
export function ArtistCard(artist, { cover, following, score, rank, signals = '' }) {
  return `<article class="artist-card">
    <button class="artist-cover" data-act="artist" data-id="${artist.id}" aria-label="Open ${esc(artist.name)}">${cover ? ArtImage(cover) : ''}</button>
    <div class="artist-card-body">
      ${Avatar(artist, 'md')}
      <div class="artist-card-text">
        <button class="artist-card-name" data-act="artist" data-id="${artist.id}">${esc(artist.name)}</button>
        <p>${esc(countryName(artist.country))}${rank ? ` · No. ${rank}` : ''}</p>
      </div>
      ${artist.isMe ? '<span class="tag">You</span>' : `<button class="follow-btn${following ? ' is-on' : ''}" data-act="follow" data-id="${artist.id}" aria-pressed="${!!following}">${following ? 'Following' : 'Follow'}</button>`}
    </div>
    ${signals ? `<div class="signal-row artist-card-signals">${signals}</div>` : ''}
    ${score != null ? `<p class="artist-card-score"><span>Artist score</span><b>${fmt(score)}</b></p>` : ''}
  </article>`;
}

// ——— Filters, search ———
export function CategoryFilter(categories, active, { act = 'filter-cat', allLabel = 'All', pills = false, noAll = false } = {}) {
  return `<div class="chip-row${pills ? ' pill-row' : ''}" role="tablist" aria-label="Filter by category">
    ${noAll ? '' : `<button class="chip${!active ? ' is-on' : ''}" role="tab" aria-selected="${!active}" data-act="${act}" data-v="">${allLabel}</button>`}
    ${categories.map((c) => `<button class="chip${active === c.id ? ' is-on' : ''}" role="tab" aria-selected="${active === c.id}" data-act="${act}" data-v="${c.id}">${esc(c.label)}</button>`).join('')}
  </div>`;
}

export function Select(id, options, value, label) {
  return `<label class="select"><span class="sr-only">${esc(label)}</span><select id="${id}">${options.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${Icon('chevron', { size: 16 })}</label>`;
}

export function SearchBar({ value = '', placeholder = 'Search artworks, artists, movements' } = {}) {
  return `<label class="search-bar">${Icon('search', { size: 18 })}<span class="sr-only">Search</span>
    <input id="search-input" type="search" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
    <kbd>Esc</kbd></label>`;
}

// ——— Battles ———
export function ArtBattleCard(art, { artist, index, elo, result }) {
  return `<article class="battle-card${result ? ` is-${result.state}` : ''}">
    <button class="battle-frame" data-act="vote" data-i="${index}" aria-label="Vote for ${esc(art.title)}" ${result ? 'disabled' : ''}>
      ${ArtImage(art, { full: true })}
      ${result ? `<span class="battle-outcome"><b>${result.delta}</b><small>${result.share}% of voters</small></span>` : ''}
    </button>
    <div class="battle-caption">
      <div><h3 class="art-title">${esc(art.title)}</h3><button class="art-artist" data-act="artist" data-id="${artist.id}">${esc(artist.name)}</button></div>
      <span class="elo">${Math.round(elo)}</span>
    </div>
    <button class="btn btn-secondary btn-block vote-btn" data-act="vote" data-i="${index}" ${result ? 'disabled' : ''}>${index === 0 ? `${Icon('back', { size: 16 })}<span>Vote Left</span>` : `<span>Vote Right</span>${Icon('arrow', { size: 16 })}`}</button>
  </article>`;
}

export function BattleArena(cards, { compact = false } = {}) {
  return `<div class="arena${compact ? ' arena-compact' : ''}">${cards[0]}<div class="vs" aria-hidden="true"><span>vs</span></div>${cards[1]}</div>`;
}

// ——— Collections ———
export function CollectionCard({ title, subtitle, works, act, attrs = '' }) {
  const tiles = works.slice(0, 4);
  return `<button class="collection-card" data-act="${act}" ${attrs}>
    <div class="mosaic mosaic-${Math.max(1, tiles.length)}">${tiles.map((w) => `<span>${ArtImage(w)}</span>`).join('')}</div>
    <span class="collection-text"><b>${esc(title)}</b><small>${esc(subtitle)}</small></span>
  </button>`;
}

// ——— States ———
export function EmptyState({ icon = 'spark', title, body = '', action = '' }) {
  return `<div class="empty-state">${Icon(icon, { size: 28 })}<h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}${action}</div>`;
}

export function LoadingSkeleton({ cards = 4, variant = 'grid' } = {}) {
  if (variant === 'list') return `<div class="skeleton-list" aria-hidden="true">${'<div class="skel skel-row"></div>'.repeat(cards)}</div>`;
  return `<div class="art-grid" aria-busy="true" aria-label="Loading">${Array.from({ length: cards }, () => '<div class="skel-card"><div class="skel skel-img"></div><div class="skel skel-line"></div><div class="skel skel-line short"></div></div>').join('')}</div>`;
}

export function SectionHeader({ eyebrow, title, action = '' }) {
  return `<header class="section-head"><div>${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h2 class="display-sm">${title}</h2></div>${action}</header>`;
}

export function Movement(delta) {
  if (delta === null || delta === undefined) return '<span class="move move-new">New</span>';
  if (delta > 0) return `<span class="move move-up" aria-label="Up ${delta}">↑ ${delta}</span>`;
  if (delta < 0) return `<span class="move move-down" aria-label="Down ${-delta}">↓ ${-delta}</span>`;
  return '<span class="move move-same" aria-label="No change">—</span>';
}
