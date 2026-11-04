// The Abremi Index (#index): the weekly public chart, its archive, and the artist's embeddable badge.
// Pure HTML builders; the chart itself is frozen on the server every Monday (migration 0016).

import { esc, fmt, flag, countryName, PremiumButton, EmptyState, SectionHeader } from '../components.js';
import { CATEGORIES } from '../../core/seed.js';

const MEDIUM = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const day = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "Oil Painting", "Portugal" or "Overall". */
export function chartLabel(chart) {
  if (chart?.startsWith('medium:')) return MEDIUM[chart.slice(7)] || chart.slice(7);
  if (chart?.startsWith('country:')) return countryName(chart.slice(8)) || chart.slice(8);
  return 'Overall';
}

/** @param {any} d index_week() result  @param {{ thumb: (id: string) => string }} o */
export function indexPage(d, { thumb }) {
  if (!d?.week) {
    return `<div class="shell">${EmptyState({ icon: 'chart', title: 'The first Abremi Index is coming', body: 'It is published every Monday from the past week of admirations and treasures.' })}</div>`;
  }
  const charts = ['overall', ...(d.charts || []).filter((c) => c !== 'overall').sort((a, b) => chartLabel(a).localeCompare(chartLabel(b)))];
  const option = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="shell index-page">
    <header class="page-head"><p class="eyebrow">Published weekly</p><h1 class="display-lg">The Abremi Index</h1>
      <p class="muted">The week’s most appreciated work by real member artists: admirations and treasures from ${esc(day(d.covers_from))} to ${esc(day(d.week))}, weighted by verified role. Your own activity never counts, sample works are never included, and plans never affect it.</p></header>
    <div class="index-controls">
      <label class="select"><span class="sr-only">Week</span><select id="index-week">${(d.weeks || []).map((w) => option(w, `Week of ${day(new Date(Date.parse(w) - 7 * 864e5).toISOString())}`, w === d.week)).join('')}</select></label>
      <label class="select"><span class="sr-only">Chart</span><select id="index-chart">${charts.map((c) => option(c, c.startsWith('country:') ? `${flag(c.slice(8))} ${chartLabel(c)}` : chartLabel(c), c === d.chart)).join('')}</select></label>
    </div>
    <div class="index-grid">
      <section>${SectionHeader({ eyebrow: chartLabel(d.chart), title: 'Works' })}
        ${d.artworks.length ? `<ol class="rank-list">${d.artworks.slice(0, 50).map((w) => `<li><button class="rank-row" data-act="artwork" data-id="${esc(w.id)}">
          <span class="rank-num">${w.rank}</span><span class="rank-thumb">${thumb(w.id)}</span>
          <span class="rank-text"><b>${esc(w.title)}</b><small>${esc(w.artist)}</small></span><span class="rank-score">${fmt(w.score)}</span></button></li>`).join('')}</ol>`
          : '<p class="muted">No works in this chart this week.</p>'}</section>
      <section>${SectionHeader({ eyebrow: chartLabel(d.chart), title: 'Artists' })}
        ${d.artists.length ? `<ol class="rank-list">${d.artists.slice(0, 50).map((a) => `<li><button class="rank-row" data-act="artist" data-id="${esc(a.id)}">
          <span class="rank-num">${a.rank}</span><span class="rank-text"><b>${esc(a.name)} <span class="flag">${flag(a.country)}</span></b><small>${esc(countryName(a.country) || '')}</small></span>
          <span class="rank-score">${fmt(a.score)}</span></button></li>`).join('')}</ol>`
          : '<p class="muted">No artists in this chart this week.</p>'}</section>
    </div>
    <p class="fine">Score: each admiration adds the member’s role weight (fan 1, artist 3, critic 5, collector 9); a treasure adds twice that. Charts are frozen every Monday and kept in the archive.</p>
  </div>`;
}

/** Studio card: the artist's place in the latest Index and the code to embed the badge. */
export function badgeEmbedHTML(b, { artistId, origin }) {
  if (!b?.rank) return '';
  const code = `<a href="${origin}/#artist/${artistId}"><img src="${origin}/api/badge?artist=${encodeURIComponent(artistId)}" alt="Abremi Index: #${b.rank} ${chartLabel(b.chart)}" height="58"></a>`;
  return `<section class="section section-tight index-badge-card">${SectionHeader({ eyebrow: 'The Abremi Index', title: `#${b.rank} · ${chartLabel(b.chart)}` })}
    <p class="muted">Your best place in this week’s Index. Put the badge on your website: it updates every week and links to your Abremi page.</p>
    <img class="index-badge-preview" src="api/badge?artist=${encodeURIComponent(artistId)}" alt="Your Abremi Index badge" height="58">
    <label class="field"><span>Embed code</span><textarea id="index-embed" rows="3" readonly>${esc(code)}</textarea></label>
    ${PremiumButton('Copy code', { act: 'index-copy', variant: 'secondary' })}
  </section>`;
}
